// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import 'leaflet/dist/leaflet.css';
import './gps-map-panel.scss';

import React, {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import ReactDOM from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import L from 'leaflet';
import Button from 'antd/lib/button';
import Segmented from 'antd/lib/segmented';
import Text from 'antd/lib/typography/Text';
import { CloseOutlined, ExportOutlined } from '@ant-design/icons';

import CVATTooltip from 'components/common/cvat-tooltip';

import { CombinedState } from 'reducers';
import { FramesMetaData } from 'cvat-core-wrapper';
import { changeFrameAsync } from 'actions/annotation-actions';

export interface GpsPoint {
    frame: number;
    latitude: number;
    longitude: number;
    altitude: number | null;
    direction: number | null;
}

export function getJobGpsPoints(
    meta: FramesMetaData | null,
    frameNumbers: number[],
    jobStartFrame: number,
): GpsPoint[] {
    if (!meta) {
        return [];
    }

    const points: GpsPoint[] = [];
    if (!Array.isArray(meta.frames) || !meta.frames.some((frameMeta) => typeof frameMeta?.latitude === 'number')) {
        // fast path for jobs without GPS data
        return [];
    }

    for (const frame of frameNumbers ?? []) {
        let frameMeta: FramesMetaData['frames'][number] | undefined;
        try {
            const frameIndex = meta.getFrameIndex(meta.getDataFrameNumber(frame - jobStartFrame));
            frameMeta = meta.frames[frameIndex];
        } catch (_error: unknown) {
            // the frame doesn't belong to the job meta (e.g. during job switching), skip it
            continue;
        }

        if (frameMeta && typeof frameMeta.latitude === 'number' && typeof frameMeta.longitude === 'number') {
            points.push({
                frame,
                latitude: frameMeta.latitude,
                longitude: frameMeta.longitude,
                altitude: frameMeta.altitude ?? null,
                direction: frameMeta.direction ?? null,
            });
        }
    }

    return points;
}

export function useJobGpsPoints(): GpsPoint[] {
    const meta = useSelector((state: CombinedState) => state.annotation.job.meta);
    const frameNumbers = useSelector((state: CombinedState) => state.annotation.job.frameNumbers);
    const jobStartFrame = useSelector((state: CombinedState) => state.annotation.job.instance?.startFrame ?? 0);

    return useMemo(
        () => getJobGpsPoints(meta, frameNumbers, jobStartFrame),
        [meta, frameNumbers, jobStartFrame],
    );
}

const TRACK_COLOR = '#ffd400';
const VIEW_STORAGE_KEY = 'cvat.annotation.gpsMapView';
const STREET_VIEW_UPDATE_DELAY = 400; // ms, avoids reloading Street View on every frame while playing

type PanelView = 'map' | 'streetview';

// "credentialless" is not in the React typings yet, React passes it to the DOM as is
const CREDENTIALLESS_IFRAME_ATTRIBUTES = { credentialless: '' } as React.IframeHTMLAttributes<HTMLIFrameElement>;

function readPanelView(): PanelView {
    try {
        return localStorage.getItem(VIEW_STORAGE_KEY) === 'streetview' ? 'streetview' : 'map';
    } catch (_error: unknown) {
        return 'map';
    }
}

function toRadians(value: number): number {
    return (value * Math.PI) / 180;
}

function bearing(from: GpsPoint, to: GpsPoint): number {
    const lat1 = toRadians(from.latitude);
    const lat2 = toRadians(to.latitude);
    const deltaLon = toRadians(to.longitude - from.longitude);
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function samePosition(a: GpsPoint, b: GpsPoint): boolean {
    return a.latitude === b.latitude && a.longitude === b.longitude;
}

// Heading for each frame: EXIF direction if the camera records it,
// otherwise the direction of movement along the track
export function computeHeadings(points: GpsPoint[]): Map<number, number | null> {
    const headings = new Map<number, number | null>();
    // many cameras write 0 when they don't know the direction
    const exifDirectionUsable = points.some((point) => point.direction !== null && point.direction !== 0);

    points.forEach((point, idx) => {
        if (exifDirectionUsable && point.direction !== null) {
            headings.set(point.frame, point.direction);
            return;
        }

        const next = points.slice(idx + 1).find((other) => !samePosition(point, other));
        if (next) {
            headings.set(point.frame, bearing(point, next));
            return;
        }

        const previous = points.slice(0, idx).reverse().find((other) => !samePosition(point, other));
        headings.set(point.frame, previous ? bearing(previous, point) : null);
    });

    return headings;
}

function streetViewEmbedUrl(point: GpsPoint, heading: number | null): string {
    // keyless legacy embed, not an official Google API: it may stop working at any time
    const cbp = `11,${Math.round(heading ?? 0)},0,0,0`;
    return `https://maps.google.com/maps?layer=c&cbll=${point.latitude},${point.longitude}` +
        `&cbp=${cbp}&output=svembed`;
}

function streetViewExternalUrl(point: GpsPoint, heading: number | null): string {
    // official Google Maps URL, works without an API key
    const params = new URLSearchParams({
        api: '1',
        map_action: 'pano',
        viewpoint: `${point.latitude},${point.longitude}`,
    });
    if (heading !== null) {
        params.set('heading', `${Math.round(heading)}`);
    }
    return `https://www.google.com/maps/@?${params.toString()}`;
}

function useDebouncedValue<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timeout = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timeout);
    }, [value, delay]);
    return debounced;
}

function makeCurrentFrameIcon(direction: number | null): L.DivIcon {
    const arrow = direction === null ? '' :
        `<div class='cvat-gps-map-direction' style='transform: rotate(${direction}deg)'></div>`;
    return L.divIcon({
        className: 'cvat-gps-map-current-marker',
        html: `${arrow}<div class='cvat-gps-map-current-dot'></div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
    });
}

interface Props {
    onClose(): void;
}

function GpsMapPanel(props: Props): JSX.Element {
    const { onClose } = props;
    const dispatch = useDispatch();
    const frameNumber = useSelector((state: CombinedState) => state.annotation.player.frame.number);
    const points = useJobGpsPoints();

    const containerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const trackLayerRef = useRef<L.LayerGroup | null>(null);
    const currentMarkerRef = useRef<L.Marker | null>(null);
    const changeFrameRef = useRef<(frame: number) => void>(() => {});
    changeFrameRef.current = (frame: number) => dispatch(changeFrameAsync(frame));

    const [view, setView] = useState<PanelView>(readPanelView);
    const changeView = useCallback((value: PanelView) => {
        setView(value);
        try {
            localStorage.setItem(VIEW_STORAGE_KEY, value);
        } catch (_error: unknown) {
            // the preference is not important enough to report
        }
    }, []);

    const currentPoint = useMemo(
        () => points.find((point) => point.frame === frameNumber) ?? null,
        [points, frameNumber],
    );
    const headings = useMemo(() => computeHeadings(points), [points]);
    const currentHeading = currentPoint ? headings.get(currentPoint.frame) ?? null : null;

    const streetViewUrl = currentPoint ? streetViewEmbedUrl(currentPoint, currentHeading) : null;
    const debouncedStreetViewUrl = useDebouncedValue(streetViewUrl, STREET_VIEW_UPDATE_DELAY);

    // create the map once
    useEffect(() => {
        if (!containerRef.current) {
            return () => {};
        }

        const map = L.map(containerRef.current, {
            preferCanvas: true,
            zoomControl: true,
            attributionControl: true,
        });

        const satellite = L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            {
                maxZoom: 21,
                maxNativeZoom: 19,
                attribution: 'Tiles &copy; Esri',
            },
        );
        const labels = L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
            { maxZoom: 21, maxNativeZoom: 19 },
        );
        const streets = L.tileLayer(
            'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            {
                maxZoom: 21,
                maxNativeZoom: 19,
                attribution: '&copy; OpenStreetMap contributors',
            },
        );

        satellite.addTo(map);
        L.control.layers(
            { Satellite: satellite, Streets: streets },
            { Labels: labels },
            { position: 'topright' },
        ).addTo(map);
        L.control.scale({ imperial: false }).addTo(map);

        trackLayerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        map.setView([0, 0], 2);

        // keep the map size in sync with the (resizable) panel and the map/street view switch
        const resizeObserver = new ResizeObserver(() => map.invalidateSize());
        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            map.remove();
            mapRef.current = null;
            trackLayerRef.current = null;
            currentMarkerRef.current = null;
        };
    }, []);

    // draw the job track
    useEffect(() => {
        const map = mapRef.current;
        const trackLayer = trackLayerRef.current;
        if (!map || !trackLayer) {
            return;
        }

        trackLayer.clearLayers();
        if (!points.length) {
            return;
        }

        const latLngs = points.map((point) => L.latLng(point.latitude, point.longitude));
        L.polyline(latLngs, {
            color: TRACK_COLOR,
            weight: 2,
            opacity: 0.8,
            interactive: false,
        }).addTo(trackLayer);

        for (const point of points) {
            L.circleMarker([point.latitude, point.longitude], {
                radius: 4,
                color: TRACK_COLOR,
                weight: 1,
                fillColor: TRACK_COLOR,
                fillOpacity: 0.9,
            })
                .bindTooltip(`Frame ${point.frame}`, { direction: 'top' })
                .on('click', () => changeFrameRef.current(point.frame))
                .addTo(trackLayer);
        }

        map.fitBounds(L.latLngBounds(latLngs), { padding: [20, 20], maxZoom: 18 });
    }, [points]);

    // show the current frame position
    useEffect(() => {
        const map = mapRef.current;
        if (!map) {
            return;
        }

        if (!currentPoint) {
            currentMarkerRef.current?.remove();
            currentMarkerRef.current = null;
            return;
        }

        const latLng = L.latLng(currentPoint.latitude, currentPoint.longitude);
        const icon = makeCurrentFrameIcon(currentHeading);
        if (currentMarkerRef.current) {
            currentMarkerRef.current.setLatLng(latLng).setIcon(icon);
        } else {
            currentMarkerRef.current = L.marker(latLng, {
                icon, interactive: false, zIndexOffset: 1000, keyboard: false,
            }).addTo(map);
        }

        if (!map.getBounds().pad(-0.1).contains(latLng)) {
            map.panTo(latLng);
        }
    }, [currentPoint, currentHeading]);

    const coordinates = currentPoint ?
        `${currentPoint.latitude.toFixed(6)}, ${currentPoint.longitude.toFixed(6)}` +
        `${currentPoint.altitude !== null ? `, ${currentPoint.altitude.toFixed(1)} m` : ''}` +
        `${currentHeading !== null ? `, ${Math.round(currentHeading)}°` : ''}` :
        'No GPS data for this frame';

    return ReactDOM.createPortal(
        <div className='cvat-gps-map-panel' ref={panelRef}>
            <div className='cvat-gps-map-panel-header'>
                <Segmented
                    className='cvat-gps-map-panel-view-switch'
                    size='small'
                    value={view}
                    onChange={(value) => changeView(value as PanelView)}
                    options={[
                        { label: 'Map', value: 'map' },
                        { label: 'Street View', value: 'streetview' },
                    ]}
                />
                <Text
                    className='cvat-gps-map-panel-coordinates'
                    type={currentPoint ? undefined : 'secondary'}
                    copyable={currentPoint ? {
                        text: `${currentPoint.latitude}, ${currentPoint.longitude}`,
                    } : false}
                >
                    {coordinates}
                </Text>
                <CVATTooltip title='Open in Google Street View'>
                    <Button
                        className='cvat-gps-map-panel-open-street-view'
                        type='text'
                        size='small'
                        icon={<ExportOutlined />}
                        disabled={!currentPoint}
                        href={currentPoint ? streetViewExternalUrl(currentPoint, currentHeading) : undefined}
                        target='_blank'
                        rel='noopener noreferrer'
                    />
                </CVATTooltip>
                <Button
                    className='cvat-gps-map-panel-close'
                    type='text'
                    size='small'
                    icon={<CloseOutlined />}
                    onClick={onClose}
                />
            </div>
            {/* the map stays mounted to keep its position and zoom while Street View is shown */}
            <div
                className='cvat-gps-map-panel-map'
                ref={containerRef}
                style={view === 'map' ? undefined : { display: 'none' }}
            />
            {view === 'streetview' && (
                <div className='cvat-gps-map-panel-street-view'>
                    {debouncedStreetViewUrl ? (
                        <iframe
                            title='Google Street View'
                            // CVAT pages are served with "Cross-Origin-Embedder-Policy: credentialless",
                            // so cross-origin iframes are blocked unless they are credentialless too
                            {...CREDENTIALLESS_IFRAME_ATTRIBUTES}
                            src={debouncedStreetViewUrl}
                            referrerPolicy='no-referrer-when-downgrade'
                            allowFullScreen
                        />
                    ) : (
                        <Text type='secondary'>No GPS data for this frame</Text>
                    )}
                </div>
            )}
        </div>,
        window.document.body,
    );
}

export default React.memo(GpsMapPanel);
