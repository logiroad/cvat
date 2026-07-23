// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    ComponentBuilder, ComponentBuilderArgs, PluginEntryPoint,
} from 'components/plugins-entrypoint';
import { rememberObject, updateAnnotationsAsync } from 'actions/annotation-actions';
import {
    Label, LabelType, ObjectType, ShapeType,
} from 'cvat-core-wrapper';

// Assigns a keyboard shortcut to every label of the current project, based on
// its rank in alphabetical order (see resolveLabelOrder below for how the
// rank itself is computed and kept stable over time).
//
// This plugin is entirely self-contained: it does NOT modify any core CVAT
// file, including CVAT's native "Switch label" shortcut (labels-list.tsx,
// Ctrl+<n> / Ctrl+Shift+<n>, mapped by label CREATION order, still present
// and unmodified). Consequently the key sequences below must be something
// the native shortcut does NOT already use - otherwise both compete for the
// same keydown and whichever wins is unpredictable (Mousetrap registration
// order), so the label you land on may silently come from the NATIVE
// creation-order mapping instead of this plugin's alphabetical one.
//
// The exact key sequences below were picked empirically, in this order of
// failed/rejected attempts (kept here so nobody re-tries them):
//   - Alt+<digit>: confirmed via document keydown listening + observing the
//     desktop that this specific machine's window manager consumes it for
//     virtual desktop switching before the browser ever sees it.
//   - bare Ctrl+<digit>: Chrome/Firefox/Edge reserve this to switch browser
//     tabs; the page never receives the keydown either.
//   - Ctrl+Shift+<digit>: reaches the page fine, but CVAT's native "Switch
//     label" shortcut (labels-list.tsx) already uses this exact sequence
//     (for labels 11-20, by creation order) - the two compete for the same
//     keydown.
//   - Ctrl+Alt+Shift+<digit>: reaches the page fine and is conflict-free,
//     but was rejected as too cumbersome to type for a frequent action.
//   - Bare digit (no modifier) is what's used below: no native CVAT shortcut
//     (component-registered or canvas-level) binds a plain digit, so there's
//     no known conflict - the trade-off is that a keypress reaches this
//     plugin whenever focus isn't inside a recognized text field (see
//     isEditableTarget below), which covers <input>/<textarea>/contentEditable
//     but not necessarily every custom widget. To verify a candidate
//     sequence reaches the page at all, listen on document and press keys:
//       document.addEventListener('keydown',
//         (e) => console.log(e.code, e.ctrlKey, e.altKey, e.shiftKey), {capture: true})
//
// ---------------------------------------------------------------------------
// EDIT THIS TABLE to customize which physical key triggers which rank.
// Entry at index 0 is the shortcut for the 1st label, index 1 for the 2nd,
// etc. The number of entries also caps how many labels get a shortcut - add
// or remove rows to change it.
//
// `codes` lists the KeyboardEvent.code values (PHYSICAL keys, independent of
// keyboard layout) that all trigger this same rank - here, the digit row and
// the numeric keypad both work for the same digit, so either can be used.
// Use `code`, not `key`: on AZERTY, the top-row "1" key without Shift reports
// key='&', not '1', which would silently break a key-based mapping; and the
// digit row vs numpad "1" report different `key`/`code` despite looking the
// same. To find the code for a given physical key, run this in the browser
// console and press it:
//   document.addEventListener('keydown', (e) => console.log(e.code), { once: true })
const SHORTCUTS: { codes: string[]; alt?: boolean; shift?: boolean; ctrl?: boolean }[] = [
    { codes: ['Digit1', 'Numpad1'] },
    { codes: ['Digit2', 'Numpad2'] },
    { codes: ['Digit3', 'Numpad3'] },
    { codes: ['Digit4', 'Numpad4'] },
    { codes: ['Digit5', 'Numpad5'] },
    { codes: ['Digit6', 'Numpad6'] },
    { codes: ['Digit7', 'Numpad7'] },
    { codes: ['Digit8', 'Numpad8'] },
    { codes: ['Digit9', 'Numpad9'] },
    { codes: ['Digit0', 'Numpad0'] },
];
// ---------------------------------------------------------------------------

// Only labels that can actually be applied to a Mask are considered for a
// shortcut slot - Tag-only labels (or any other type incompatible with masks,
// per applyLabel's own compatibility check below) are skipped entirely so
// they never waste one of the 10 ranks. Adjust this set if shortcuts should
// instead target a different shape type.
const ELIGIBLE_LABEL_TYPES = new Set<LabelType>([LabelType.MASK, LabelType.ANY]);

// Which alphabetical rank (1-based, among ELIGIBLE_LABEL_TYPES labels, in the
// stable order resolveLabelOrder maintains - see below) feeds each shortcut
// slot. Defaults to 1..SHORTCUTS.length (sequential), but ranks can be
// skipped or repeated freely: e.g. [1, 2, 3, 4, 5, 6, 11, 12, 13, 14] makes
// the first 6 shortcuts target ranks 1-6 as usual, and the last 4 jump to
// ranks 11-14, leaving 7-10 with no shortcut at all. Must have exactly
// SHORTCUTS.length entries.
const SLOT_RANKS: number[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13];

type Shortcut = (typeof SHORTCUTS)[number];

function displayCode(code: string): string {
    if (code.startsWith('Digit')) return code.slice('Digit'.length);
    if (code.startsWith('Numpad')) return code.slice('Numpad'.length);
    if (code.startsWith('Key')) return code.slice('Key'.length);
    return code;
}

// Assignments (which label gets which rank) are persisted per project in
// localStorage, so they stay stable across job changes within a project and
// are restored when coming back to a project later. If new labels are added
// to a project afterwards, they are appended after the already-assigned ones
// (alphabetically among themselves) instead of shifting every existing rank.
const STORAGE_KEY = 'pluginLabelShortcutsOrder';

function formatShortcut(shortcut: Shortcut): string {
    const parts: string[] = [];
    if (shortcut.ctrl) parts.push('Ctrl');
    if (shortcut.alt) parts.push('Alt');
    if (shortcut.shift) parts.push('Shift');
    parts.push(displayCode(shortcut.codes[0]));
    return parts.join('+');
}

function eventMatchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
    return !event.metaKey &&
        shortcut.codes.includes(event.code) &&
        event.altKey === !!shortcut.alt &&
        event.shiftKey === !!shortcut.shift &&
        event.ctrlKey === !!shortcut.ctrl;
}

function findShortcutIndex(event: KeyboardEvent): number {
    return SHORTCUTS.findIndex((shortcut) => eventMatchesShortcut(event, shortcut));
}

function readStorage(): Map<number, number[]> {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(raw) || raw.some((entry) => (
            !Array.isArray(entry) || !Number.isInteger(entry[0]) || !Array.isArray(entry[1])
        ))) {
            throw new Error('Incorrect format from local storage');
        }
        return new Map(raw);
    } catch (_error: unknown) {
        return new Map();
    }
}

function writeStorage(storage: Map<number, number[]>): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(storage.entries())));
}

// Keeps the previously stored label order for a project (so existing ranks
// never move), appends any new label alphabetically at the end, and drops
// labels that no longer exist / are no longer eligible. Returns the FULL
// list (rank 1 first) - SLOT_RANKS decides which ranks actually get a
// shortcut, see the caller.
function resolveLabelOrder(projectId: number, projectLabels: Label[]): Label[] {
    const storage = readStorage();
    const storedOrder = storage.get(projectId) || [];
    const byId = new Map(projectLabels.map((label) => [label.id as number, label]));

    const ordered: Label[] = [];
    for (const labelId of storedOrder) {
        const label = byId.get(labelId);
        if (label) {
            ordered.push(label);
            byId.delete(labelId);
        }
    }

    const newLabels = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
    ordered.push(...newLabels);

    storage.set(projectId, ordered.map((label) => label.id as number));
    writeStorage(storage);

    return ordered;
}

// Applies SLOT_RANKS on top of the full rank-ordered label list, warning
// about ranks that don't exist (project has fewer eligible labels than
// requested) so a typo in SLOT_RANKS doesn't fail silently.
function applySlotRanks(projectId: number, rankedLabels: Label[]): Label[] {
    return SLOT_RANKS.map((rank, slotIndex) => {
        const label = rankedLabels[rank - 1];
        if (!label) {
            // eslint-disable-next-line no-console
            console.warn(
                `[label-shortcuts] Project ${projectId}: SLOT_RANKS[${slotIndex}] asks for rank ${rank}, ` +
                `but only ${rankedLabels.length} eligible label(s) exist - that shortcut stays unassigned.`,
            );
        }
        return label;
    });
}

function isEditableTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
}

// Reproduces what used to be LabelsListComponent.handleHelper's relabeling
// logic (labels-list.tsx, before its native shortcut was removed in favor of
// this plugin): relabel the activated object if applicable, otherwise
// remember the label as the default for the next drawn object.
function applyLabel(
    store: ComponentBuilderArgs['store'],
    dispatch: ComponentBuilderArgs['dispatch'],
    label: Label,
): void {
    const state = store.getState();
    const { states, activatedStateID } = state.annotation.annotations;
    const { activeShapeType, activeObjectType } = state.annotation.drawing;
    const { showPrivateAttributes } = state.settings.workspace;

    if (!showPrivateAttributes && !Number.isInteger(activatedStateID)) {
        window.dispatchEvent(new CustomEvent('ncp:select-label', { detail: { label } }));
        return;
    }

    if (Number.isInteger(activatedStateID)) {
        const activatedState = states.find((_state) => _state.clientID === activatedStateID);
        if (!activatedState) return;
        const bothAreTags = activatedState.objectType === ObjectType.TAG && label.type === LabelType.TAG;
        const labelIsApplicable = label.type === LabelType.ANY ||
            (activatedState.shapeType === label.type && activatedState.shapeType !== ShapeType.SKELETON) ||
            bothAreTags;
        if (labelIsApplicable) {
            activatedState.label = label;
            dispatch(updateAnnotationsAsync([activatedState]));
        }
        return;
    }

    if (label.type === LabelType.TAG) {
        dispatch(rememberObject({ activeLabelID: label.id, activeObjectType: ObjectType.TAG }, false));
    } else if (label.type === LabelType.MASK) {
        dispatch(rememberObject({
            activeLabelID: label.id,
            activeObjectType: ObjectType.SHAPE,
            activeShapeType: ShapeType.MASK,
        }, false));
    } else {
        dispatch(rememberObject({
            activeLabelID: label.id,
            activeObjectType: activeObjectType !== ObjectType.TAG ? activeObjectType : ObjectType.SHAPE,
            activeShapeType: label.type === LabelType.ANY && activeShapeType !== ShapeType.SKELETON ?
                activeShapeType : (label.type as unknown as ShapeType),
        }, false));
    }
}

// Tracks the last project we already computed shortcuts for, so switching
// jobs within the same project is a no-op.
let lastHandledProjectId: number | null = null;
let currentOrderedLabels: (Label | undefined)[] = [];

const builder: ComponentBuilder = ({ dispatch, store, core }) => {
    const handleKeydown = (event: KeyboardEvent): void => {
        if (isEditableTarget(event.target)) return;
        const index = findShortcutIndex(event);
        if (index === -1) return;
        const label = currentOrderedLabels[index];
        if (!label) return;
        event.preventDefault();
        applyLabel(store, dispatch, label);
    };

    window.addEventListener('keydown', handleKeydown);

    return {
        name: 'Label shortcuts (alphabetical, per project)',
        destructor: () => {
            window.removeEventListener('keydown', handleKeydown);
            lastHandledProjectId = null;
            currentOrderedLabels = [];
        },
        globalStateDidUpdate: () => {
            const state = store.getState();
            const jobInstance = state.annotation.job.instance;
            if (!jobInstance) {
                return;
            }

            const { projectId } = jobInstance;
            if (!projectId || projectId === lastHandledProjectId) {
                return;
            }

            lastHandledProjectId = projectId;
            core.projects.get({ id: projectId }).then(([project]) => {
                if (!project || lastHandledProjectId !== projectId) return;
                const eligibleLabels = project.labels.filter((label) => ELIGIBLE_LABEL_TYPES.has(label.type));
                const rankedLabels = resolveLabelOrder(projectId, eligibleLabels);
                currentOrderedLabels = applySlotRanks(projectId, rankedLabels);

                // eslint-disable-next-line no-console
                console.info(
                    `[label-shortcuts] Project ${projectId}: `,
                    currentOrderedLabels
                        .map((label, index) => (
                            label ? `${formatShortcut(SHORTCUTS[index])} -> "${label.name}"` : null
                        ))
                        .filter(Boolean)
                        .join(', '),
                );
            }).catch((error: unknown) => {
                // eslint-disable-next-line no-console
                console.error('[label-shortcuts] Failed to load project labels', error);
            });
        },
    };
};

function register(): void {
    if (Object.prototype.hasOwnProperty.call(window, 'cvatUI')) {
        (window as any as { cvatUI: { registerComponent: PluginEntryPoint } })
            .cvatUI.registerComponent(builder);
    }
}

window.addEventListener('plugins.ready', register, { once: true });
