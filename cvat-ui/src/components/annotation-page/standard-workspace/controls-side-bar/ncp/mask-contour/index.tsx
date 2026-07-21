// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/**
 * MaskContourControl — NCP sidebar button that cycles the mask rendering through
 * three states: normal → contour highlight (faded mask + red outline) → contour
 * only (red outline). The heavy lifting (canvas-DOM class juggling, filter/style
 * injection, reapplying after canvas re-renders) lives in the sibling controller
 * module; this component is just the button + tooltip.
 */

import React from 'react';
import Icon from '@ant-design/icons';
import { useSelector } from 'react-redux';

import { MaskContourSVGIcon } from 'icons';
import { Canvas } from 'cvat-canvas-wrapper';
import { CombinedState } from 'reducers';
import CVATTooltip from 'components/common/cvat-tooltip';

import { ContourMode, activateContour, applyContourMode } from './mask-contour-controller';

export interface Props {
    canvasInstance: Canvas;
    mode: ContourMode;
    onCycle(): void;
}

const MODE_TITLES: Record<ContourMode, string> = {
    none: 'Show mask contours',
    highlight: 'Mask contours: highlighted (mask + outline)',
    only: 'Mask contours: outline only',
};

function MaskContourControl(props: Props): JSX.Element {
    const { canvasInstance, mode, onCycle } = props;
    const { normalizedKeyMap } = useSelector((state: CombinedState) => state.shortcuts);

    // Attach the canvas.setup listener for the lifetime of the control so the
    // active mode survives frame changes / mask edits; clean up on unmount.
    React.useEffect(() => activateContour(canvasInstance), [canvasInstance]);

    // Reapply whenever the user cycles the mode.
    React.useEffect(() => {
        applyContourMode(mode);
    }, [mode]);

    const shortcut = normalizedKeyMap.TOGGLE_MASK_CONTOUR;
    const title = shortcut ? `${MODE_TITLES[mode]} [${shortcut}]` : MODE_TITLES[mode];

    return (
        <CVATTooltip title={title} placement='right'>
            <Icon
                className={mode !== 'none' ?
                    'cvat-mask-contour-control cvat-active-canvas-control' :
                    'cvat-mask-contour-control'}
                component={MaskContourSVGIcon}
                onClick={onCycle}
            />
        </CVATTooltip>
    );
}

Object.assign(MaskContourControl, { displayName: 'MaskContourControl' });
export default React.memo(MaskContourControl);
