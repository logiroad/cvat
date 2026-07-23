// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { ComponentBuilder, ComponentBuilderArgs, PluginEntryPoint } from 'components/plugins-entrypoint';
import { setNavigationType } from 'actions/annotation-actions';
import { NavigationType } from 'reducers';
import { Job, ObjectType } from 'cvat-core-wrapper';

// Label of the Tag annotation created by the auto-validation process.
// A frame is considered already reviewed - and therefore skipped by
// "next/previous filtered frame" navigation - as soon as it carries this tag.
//
// Note: we deliberately do NOT set an "annotationsFilters" entry via
// changeAnnotationsFilters() to reflect this. That Redux state is not purely
// a UI hint - fetchAnnotations() (annotation-actions.ts) passes it straight
// into jobInstance.annotations.get(frame, ..., filters) to decide which
// objects are fetched/rendered for the CURRENT frame, not just which frames
// match during navigation. Setting a "type==tag" filter there would hide
// every non-tag shape/track on every frame. The search() override below is
// the only thing that needs to know about this label; it works regardless of
// what state.annotation.annotations.filters holds (even the default `[]`).
const AUTO_VALIDATED_TAG_LABEL = 'auto_validated';

type SearchParameters = {
    allowDeletedFrames: boolean;
    annotationsFilters?: object[];
    generalFilters?: { isEmptyFrame?: boolean };
};
type SearchFn = (frameFrom: number, frameTo: number, searchParameters: SearchParameters) => Promise<number | null>;

// Replaces jobInstance.annotations.search (called by the native "Filtered"
// navigation buttons) with a version that walks frames one by one and skips
// any frame already carrying the auto_validated tag - a condition the native
// JsonLogic filter engine cannot express (see comment above).
function patchSearch(jobInstance: Job, store: ComponentBuilderArgs['store']): void {
    const { annotations } = jobInstance;
    const originalSearch: SearchFn = annotations.search.bind(annotations);

    annotations.search = async (
        frameFrom: number,
        frameTo: number,
        searchParameters: SearchParameters,
    ): Promise<number | null> => {
        // Other navigation modes (Empty, Chapter, ...) keep the native behaviour.
        if (!searchParameters.annotationsFilters || searchParameters.generalFilters) {
            return originalSearch(frameFrom, frameTo, searchParameters);
        }

        const { allowDeletedFrames } = searchParameters;
        const sign = Math.sign(frameTo - frameFrom);
        const predicate = sign > 0 ? (frame: number) => frame <= frameTo : (frame: number) => frame >= frameTo;
        const step = sign > 0 ? 1 : -1;

        for (let frame = frameFrom; predicate(frame); frame += step) {
            const { deletedFrames } = store.getState().annotation.job.meta ?? { deletedFrames: {} };
            if (!allowDeletedFrames && deletedFrames?.[frame]) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const states = await annotations.get(frame, false, []);
            const alreadyValidated = states.some(
                (state) => state.objectType === ObjectType.TAG && state.label?.name === AUTO_VALIDATED_TAG_LABEL,
            );
            if (!alreadyValidated) {
                return frame;
            }
        }

        return null;
    };
}

// Tracks the last job we already set up, so we don't redo it on every
// unrelated Redux state update.
let lastHandledJobID: number | null = null;

const builder: ComponentBuilder = ({ dispatch, store }) => ({
    name: 'Skip auto-validated frames',
    destructor: () => {
        lastHandledJobID = null;
    },
    globalStateDidUpdate: () => {
        const state = store.getState();
        const jobInstance = state.annotation.job.instance;

        if (!jobInstance) {
            lastHandledJobID = null;
            return;
        }

        if (state.annotation.job.fetching || jobInstance.id === lastHandledJobID) {
            return;
        }

        lastHandledJobID = jobInstance.id;
        patchSearch(jobInstance, store);
        dispatch(setNavigationType(NavigationType.FILTERED));
    },
});

function register(): void {
    if (Object.prototype.hasOwnProperty.call(window, 'cvatUI')) {
        (window as any as { cvatUI: { registerComponent: PluginEntryPoint } })
            .cvatUI.registerComponent(builder);
    }
}

window.addEventListener('plugins.ready', register, { once: true });
