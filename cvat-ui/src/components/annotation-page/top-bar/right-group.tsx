// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useCallback, useState } from 'react';
import { Col } from 'antd/lib/grid';
import Icon, { EnvironmentOutlined, InfoCircleOutlined } from '@ant-design/icons';
import Select from 'antd/lib/select';
import Button from 'antd/lib/button';
import Modal from 'antd/lib/modal';
import notification from 'antd/lib/notification';

import { FilterIcon, FullscreenIcon, GuideIcon } from 'icons';
import config from 'config';
import {
    DimensionType, Job, JobStage, JobState,
} from 'cvat-core-wrapper';
import { Workspace } from 'reducers';

import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';

import CVATTooltip from 'components/common/cvat-tooltip';
import GpsMapPanel, { useJobGpsPoints } from './gps-map-panel';

interface Props {
    showStatistics(): void;
    showFilters(): void;
    changeWorkspace(workspace: Workspace): void;
    jobInstance: Job;
    workspace: Workspace;
    annotationFilters: object[];
    initialOpenGuide: boolean;
}

const GPS_MAP_VISIBLE_STORAGE_KEY = 'cvat.annotation.gpsMapVisible';

function readGpsMapVisible(): boolean {
    try {
        return localStorage.getItem(GPS_MAP_VISIBLE_STORAGE_KEY) === 'true';
    } catch (_error: unknown) {
        return false;
    }
}

function GpsMapToggle(): JSX.Element | null {
    const gpsPoints = useJobGpsPoints();
    const [visible, setVisible] = useState<boolean>(readGpsMapVisible);

    const toggle = useCallback((value: boolean) => {
        setVisible(value);
        try {
            localStorage.setItem(GPS_MAP_VISIBLE_STORAGE_KEY, `${value}`);
        } catch (_error: unknown) {
            // the preference is not important enough to report
        }
    }, []);

    if (!gpsPoints.length) {
        return null;
    }

    return (
        <>
            <CVATTooltip title='Show frame GPS positions on a satellite map'>
                <Button
                    type='link'
                    className={`cvat-annotation-header-map-button cvat-annotation-header-button ${
                        visible ? 'cvat-button-active' : ''
                    }`}
                    onClick={() => toggle(!visible)}
                >
                    <EnvironmentOutlined />
                    Map
                </Button>
            </CVATTooltip>
            { visible && <GpsMapPanel onClose={() => toggle(false)} /> }
        </>
    );
}

function RightGroup(props: Props): JSX.Element {
    const {
        showStatistics,
        changeWorkspace,
        showFilters,
        workspace,
        jobInstance,
        annotationFilters,
        initialOpenGuide,
    } = props;

    const filters = annotationFilters.length;

    const openGuide = useCallback(() => {
        const PADDING = Math.min(window.screen.availHeight, window.screen.availWidth) * 0.4;
        jobInstance.guide().then((guide) => {
            if (guide) {
                Modal.info({
                    icon: null,
                    width: window.screen.availWidth - PADDING,
                    className: 'cvat-annotation-view-markdown-guide-modal',
                    content: (
                        <MDEditor
                            visibleDragbar={false}
                            data-color-mode='light'
                            height={window.screen.availHeight - PADDING}
                            preview='preview'
                            hideToolbar
                            value={guide.markdown}
                            previewOptions={{ rehypePlugins: [[rehypeSanitize]] }}
                        />
                    ),
                });
            }
        }).catch((error: unknown) => {
            notification.error({
                message: 'Could not receive annotation guide',
                description: error instanceof Error ? error.message : 'Unknown error',
            });
        });
    }, [jobInstance]);

    useEffect(() => {
        if (Number.isInteger(jobInstance?.guideId)) {
            if (initialOpenGuide) {
                openGuide();
            } else if (
                jobInstance?.stage === JobStage.ANNOTATION &&
                jobInstance?.state === JobState.NEW
            ) {
                let seenGuides = [];
                try {
                    seenGuides = JSON.parse(localStorage.getItem('seenGuides') || '[]');
                    if (!Array.isArray(seenGuides) || seenGuides.some((el) => !Number.isInteger(el))) {
                        throw new Error('Wrong structure stored in local storage');
                    }
                } catch (_error: unknown) {
                    seenGuides = [];
                }

                if (!seenGuides.includes(jobInstance.guideId)) {
                    // open guide if the user have not seen it yet
                    openGuide();
                    const updatedSeenGuides = Array
                        .from(new Set([
                            jobInstance.guideId,
                            ...seenGuides.slice(0, config.LOCAL_STORAGE_SEEN_GUIDES_MEMORY_LIMIT - 1),
                        ]));
                    localStorage.setItem('seenGuides', JSON.stringify(updatedSeenGuides));
                }
            }
        }
    }, []);

    return (
        <Col className='cvat-annotation-header-right-group'>
            <Button
                type='link'
                className='cvat-annotation-header-fullscreen-button cvat-annotation-header-button'
                onClick={(): void => {
                    if (window.document.fullscreenEnabled) {
                        if (window.document.fullscreenElement) {
                            window.document.exitFullscreen();
                        } else {
                            window.document.documentElement.requestFullscreen();
                        }
                    }
                }}
            >
                <Icon component={FullscreenIcon} />
                Fullscreen
            </Button>
            { jobInstance.guideId !== null && (
                <Button
                    type='link'
                    className='cvat-annotation-header-guide-button cvat-annotation-header-button'
                    onClick={openGuide}
                >
                    <Icon component={GuideIcon} />
                    Guide
                </Button>
            )}
            { jobInstance.mediaType === 'image' && jobInstance.dimension === DimensionType.DIMENSION_2D && (
                <GpsMapToggle />
            )}
            <Button
                type='link'
                className='cvat-annotation-header-info-button cvat-annotation-header-button'
                onClick={showStatistics}
            >
                <InfoCircleOutlined />
                Info
            </Button>
            <Button
                type='link'
                className={`cvat-annotation-header-filters-button cvat-annotation-header-button ${filters ?
                    'filters-armed' : ''
                }`}
                onClick={showFilters}
            >
                <Icon component={FilterIcon} />
                Filters
            </Button>
            <div>
                <Select
                    popupClassName='cvat-workspace-selector-dropdown'
                    className='cvat-workspace-selector'
                    onChange={changeWorkspace}
                    value={workspace}
                >
                    {Object.values(Workspace).map((ws) => {
                        if (jobInstance.mediaType !== 'audio' && ws === Workspace.AUDIO) {
                            return null;
                        }
                        if (jobInstance.dimension === DimensionType.DIMENSION_3D) {
                            if (ws === Workspace.STANDARD) {
                                return null;
                            }
                            return (
                                <Select.Option disabled={ws !== Workspace.STANDARD3D} key={ws} value={ws}>
                                    {ws}
                                </Select.Option>
                            );
                        }
                        if (ws !== Workspace.STANDARD3D) {
                            return (
                                <Select.Option key={ws} value={ws}>
                                    {ws}
                                </Select.Option>
                            );
                        }
                        return null;
                    })}
                </Select>
            </div>
        </Col>
    );
}

export default React.memo(RightGroup);
