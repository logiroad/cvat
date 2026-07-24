// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    ComponentBuilder, ComponentBuilderArgs, PluginEntryPoint,
} from 'components/plugins-entrypoint';
import {
    changeFrameAsync, rememberObject, removeObjectAsync, repeatDrawShapeAsync,
    searchAnnotationsAsync, searchChaptersAsync, switchPlay, updateAnnotationsAsync,
} from 'actions/annotation-actions';
import {
    Label, LabelType, ObjectType, ShapeType,
} from 'cvat-core-wrapper';
import { ActiveControl, NavigationType } from 'reducers';
import isAbleToChangeFrame from 'utils/is-able-to-change-frame';
import { Canvas, CanvasMode } from 'cvat-canvas-wrapper';

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
// slot, when the signed-in user has no personal override (see further down).
// Sequential (1..SHORTCUTS.length) by default, but ranks can be skipped or
// repeated freely: e.g. [1, 2, 3, 4, 5, 6, 11, 12, 13, 14] makes the first 6
// shortcuts target ranks 1-6 as usual, and the last 4 jump to ranks 11-14,
// leaving 7-10 with no shortcut at all. Must have exactly SHORTCUTS.length
// entries.
const DEFAULT_SLOT_RANKS: number[] = [1, 2, 3, 4, 5, 6, 13, 12, 10, 11];

// Every signed-in CVAT user can override DEFAULT_SLOT_RANKS with their own
// mapping, persisted in THIS browser's localStorage under their user ID (so
// it does not follow them to a different browser/machine, and does not
// require editing this file or rebuilding). From the browser console, on
// the CVAT tab, run:
//   cvatLabelShortcuts.setSlotRanks([1, 2, 3, 4, 5, 6, 11, 12, 13, 14])
//   cvatLabelShortcuts.getSlotRanks()     // currently effective ranks
//   cvatLabelShortcuts.resetSlotRanks()   // back to DEFAULT_SLOT_RANKS
const SLOT_RANKS_STORAGE_PREFIX = 'pluginLabelShortcutsSlotRanks';

function isValidSlotRanks(value: unknown): value is number[] {
    return Array.isArray(value) && value.length > 0 && value.every((rank) => Number.isInteger(rank) && rank > 0);
}

function readUserSlotRanksOverride(userId: number): number[] | null {
    try {
        const raw = JSON.parse(localStorage.getItem(`${SLOT_RANKS_STORAGE_PREFIX}:${userId}`) || 'null');
        return isValidSlotRanks(raw) ? raw : null;
    } catch (_error: unknown) {
        return null;
    }
}

function writeUserSlotRanksOverride(userId: number, ranks: number[]): void {
    localStorage.setItem(`${SLOT_RANKS_STORAGE_PREFIX}:${userId}`, JSON.stringify(ranks));
}

function clearUserSlotRanksOverride(userId: number): void {
    localStorage.removeItem(`${SLOT_RANKS_STORAGE_PREFIX}:${userId}`);
}

function effectiveSlotRanks(userId: number | null): number[] {
    if (userId === null) return DEFAULT_SLOT_RANKS;
    return readUserSlotRanksOverride(userId) || DEFAULT_SLOT_RANKS;
}

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

// Applies the given slot ranks on top of the full rank-ordered label list,
// warning about ranks that don't exist (project has fewer eligible labels
// than requested) so a typo in a SLOT_RANKS override doesn't fail silently.
function applySlotRanks(projectId: number, rankedLabels: Label[], slotRanks: number[]): Label[] {
    return slotRanks.map((rank, slotIndex) => {
        const label = rankedLabels[rank - 1];
        if (!label) {
            // eslint-disable-next-line no-console
            console.warn(
                `[label-shortcuts] Project ${projectId}: slot rank [${slotIndex}] asks for rank ${rank}, ` +
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

// ---------------------------------------------------------------------------
// Extra, unrelated to label shortcuts: make the numeric keypad's "+" key
// behave like "n" (CVAT's native "Draw mode" shortcut, standard 2D workspace
// only).
//
// Root cause (confirmed by reading node_modules/mousetrap/mousetrap.js):
// CVAT's shared GlobalHotKeys component (utils/mousetrap-react.tsx) always
// binds shortcuts with action:'keydown'. Mousetrap's own _getKeyInfo has a
// _SHIFT_MAP that, for any *:'keydown'* binding (not 'keypress'), silently
// rewrites the key '+' to '=' plus a required 'shift' modifier - i.e. it
// assumes "+" can only ever come from Shift+Equal (true on a QWERTY top row,
// false for the numpad's dedicated "+" key, which involves no Shift and no
// "=" at all). So adding "+" as a sequence to "Draw mode" in Settings >
// Shortcuts appears to work (it's saved, shown in the field, survives a
// reload) but can never actually fire from the numpad. This can't be fixed
// from a plugin - it lives in CVAT's shared keybinding component and in the
// mousetrap npm package - so instead we bypass Mousetrap entirely for this
// one key.
//
// There are actually two different native "n" behaviors, chosen by
// controls-side-bar.tsx (containers/.../controls-side-bar.tsx:94-104) based
// on state.settings.workspace.showPrivateAttributes:
//   - showPrivateAttributes === true  -> "Gold" / standard mode:
//     handleDrawMode(event, 'draw') from controls-side-bar.tsx.
//   - showPrivateAttributes === false -> "Rabbit" / NCP mode:
//     ncp-controls-side-bar.tsx's own SWITCH_DRAW_MODE_STANDARD_CONTROLS
//     handler, which also treats ActiveControl.RABBIT as "currently
//     drawing", and when idle dispatches a `ncp:open-rabbit` window
//     CustomEvent (opening the rabbit class-picker popover) instead of
//     calling repeatDrawShapeAsync.
// Both are replicated below against the canvas/Redux state directly.
function triggerDrawMode(store: ComponentBuilderArgs['store'], dispatch: ComponentBuilderArgs['dispatch']): void {
    const state = store.getState();
    const { instance: canvasInstance, activeControl } = state.annotation.canvas;
    if (!(canvasInstance instanceof Canvas)) return;
    const rabbitMode = !state.settings.workspace.showPrivateAttributes;

    const drawingControls = [
        ActiveControl.DRAW_POINTS,
        ActiveControl.DRAW_POLYGON,
        ActiveControl.DRAW_POLYLINE,
        ActiveControl.DRAW_RECTANGLE,
        ActiveControl.DRAW_CUBOID,
        ActiveControl.DRAW_ELLIPSE,
        ActiveControl.DRAW_SKELETON,
        ActiveControl.DRAW_MASK,
        ActiveControl.AI_TOOLS,
        ActiveControl.OPENCV_TOOLS,
        ...(rabbitMode ? [ActiveControl.RABBIT] : []),
    ];
    const drawing = drawingControls.includes(activeControl);
    const editing = canvasInstance.mode() === CanvasMode.EDIT;

    if (rabbitMode && !drawing && !editing) {
        window.dispatchEvent(new CustomEvent('ncp:open-rabbit'));
        return;
    }

    if (!drawing) {
        if (editing) {
            // users probably will press N (or here, +) expecting to finish editing
            canvasInstance.edit({ enabled: false });
            return;
        }
        canvasInstance.cancel();
        // repeatDrawShapeAsync reads the latest draw parameters from Redux
        // state itself and calls canvasInstance.draw() with them.
        dispatch(repeatDrawShapeAsync());
    } else if ([ActiveControl.AI_TOOLS, ActiveControl.OPENCV_TOOLS].includes(activeControl)) {
        canvasInstance.interact({ enabled: false });
    } else {
        canvasInstance.draw({ enabled: false });
    }
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Extra: make the numeric keypad's "-" key behave like "Delete" (CVAT's
// native "Delete object" shortcut, DELETE_OBJECT_STANDARD_WORKSPACE,
// objects-list.tsx). Numpad "-" doesn't hit the same _SHIFT_MAP rewrite as
// "+" (there is no bare '-' entry in Mousetrap's _SHIFT_MAP, only '_'), so
// adding it through Settings > Shortcuts does work - this is here anyway so
// both keys are handled the same, consistent way, without depending on a
// per-browser Settings edit that "Restore Defaults" would wipe out. Shift+
// Numpad "-" forces deletion of locked objects, mirroring "shift+del".
//
// Note: objects-list.tsx's native handler dispatches the PLAIN removeObject
// action (just sets state.annotation.remove), relying on a separately
// mounted <RemoveConfirmComponent> to notice that state and then dispatch
// the real removeObjectAsync (immediately, unless the object is locked or a
// track and force is false, in which case it shows a confirmation dialog
// first). Depending on that separate component reacting to our dispatch
// proved unreliable, so this calls removeObjectAsync directly instead -
// objectState.delete() (cvat-core) already refuses to delete a locked
// object when force is false, so the safety behavior is preserved; the only
// difference is the "are you sure, this is a track" dialog is skipped.
function triggerDeleteActivatedObject(
    store: ComponentBuilderArgs['store'],
    dispatch: ComponentBuilderArgs['dispatch'],
    force: boolean,
): void {
    const state = store.getState();
    const { activatedStateID, states } = state.annotation.annotations;
    // eslint-disable-next-line no-console
    console.info('[label-shortcuts] delete: activatedStateID =', activatedStateID, 'states.length =', states.length);
    if (!Number.isInteger(activatedStateID)) {
        // eslint-disable-next-line no-console
        console.warn('[label-shortcuts] delete: no activated object, nothing to delete');
        return;
    }
    const activatedState = states.find((_state) => _state.clientID === activatedStateID);
    if (!activatedState) {
        // eslint-disable-next-line no-console
        console.warn('[label-shortcuts] delete: activatedStateID set but no matching state found in states[]');
        return;
    }
    // eslint-disable-next-line no-console
    console.info('[label-shortcuts] delete: dispatching removeObjectAsync for', activatedState.objectType, 'force =', force);
    dispatch(removeObjectAsync(activatedState, force));
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Extra: make the numeric keypad's "/" and "*" keys behave like "d" and "f"
// (CVAT's native Previous/Next frame shortcuts, PREV_FRAME/NEXT_FRAME,
// player-buttons.tsx). Chosen because the numpad's top row (NumLock, /, *, -)
// is present on essentially every keyboard with a numpad (built-in on any
// 102+-key keyboard, or an external USB numpad) - "/" sits left of "*",
// matching backward/forward.
//
// "d"/"f" are plain letters, not present in Mousetrap's _SHIFT_MAP, so they
// don't have the "+" bug - but this still bypasses Mousetrap and replicates
// onPrevFrame/onNextFrame (containers/annotation-page/top-bar/top-bar.tsx)
// directly, for the same reason "-" needed capture+stopPropagation: "/" is
// already a native alternate sequence for "Switch occluded" (objects-list.tsx,
// sequences: ['q', '/']) in the objects sidebar scope, and would otherwise
// fire alongside our navigation.
//
// This mirrors the exact logic of onPrevFrame/onNextFrame, including
// respecting the current navigationType (Regular/Filtered/Chapter/Empty) -
// notably, when skip-auto-validated has set FILTERED navigation, this calls
// the same searchAnnotationsAsync -> jobInstance.annotations.search that
// plugin patches, so "/" and "*" correctly skip auto_validated frames too.
async function triggerFrameNavigation(
    store: ComponentBuilderArgs['store'],
    dispatch: ComponentBuilderArgs['dispatch'],
    direction: 'next' | 'prev',
): Promise<void> {
    const state = store.getState();
    const jobInstance = state.annotation.job.instance;
    if (!jobInstance) return;

    const { number: frameNumber } = state.annotation.player.frame;
    const { playing, navigationType } = state.annotation.player;
    const { showDeletedFrames } = state.settings.player;
    const { startFrame, stopFrame } = jobInstance;

    const frameFrom = direction === 'next' ?
        Math.min(stopFrame, frameNumber + 1) :
        Math.max(startFrame, frameNumber - 1);
    const boundary = direction === 'next' ? stopFrame : startFrame;

    const newFrame = await jobInstance.frames.search({ notDeleted: !showDeletedFrames }, frameFrom, boundary);
    if (newFrame === null || newFrame === frameNumber || !isAbleToChangeFrame(newFrame)) return;

    if (playing) dispatch(switchPlay(false));

    if (navigationType === NavigationType.REGULAR) {
        dispatch(changeFrameAsync(newFrame));
    } else if (navigationType === NavigationType.FILTERED) {
        dispatch(searchAnnotationsAsync(jobInstance, newFrame, boundary));
    } else if (navigationType === NavigationType.CHAPTER) {
        dispatch(searchChaptersAsync(jobInstance, newFrame, boundary));
    } else {
        dispatch(searchAnnotationsAsync(jobInstance, newFrame, boundary, { isEmptyFrame: true }));
    }
}
// ---------------------------------------------------------------------------

// Tracks the last project we already fetched labels for, so switching jobs
// within the same project doesn't refetch. rankedLabels is cached alongside
// it so a personal SLOT_RANKS override (see cvatLabelShortcuts below) can be
// re-applied instantly, without a network round-trip.
let lastHandledProjectId: number | null = null;
let lastRankedLabels: Label[] = [];
let currentOrderedLabels: (Label | undefined)[] = [];

function logCurrentMapping(projectId: number): void {
    // eslint-disable-next-line no-console
    console.info(
        `[label-shortcuts] Project ${projectId}: `,
        currentOrderedLabels
            .map((label, index) => (label ? `${formatShortcut(SHORTCUTS[index])} -> "${label.name}"` : null))
            .filter(Boolean)
            .join(', '),
    );
}

function recomputeCurrentOrderedLabels(projectId: number, userId: number | null): void {
    currentOrderedLabels = applySlotRanks(projectId, lastRankedLabels, effectiveSlotRanks(userId));
    logCurrentMapping(projectId);
}

const builder: ComponentBuilder = ({ dispatch, store, core }) => {
    // Registered with {capture: true} and, below, explicit stopPropagation()
    // calls: CVAT's native shortcuts (Mousetrap, bound on `document`) run in
    // the bubble phase and call stopPropagation() themselves once a sequence
    // matches. Both Numpad "-" (natively "Move to background", TO_BACKGROUND,
    // default sequences ['-', '_']) and the digit keys used for label
    // shortcuts could otherwise be silently swallowed before ever reaching a
    // plain bubble-phase listener on `window` (this is what was happening to
    // "-": it was actually triggering "Move to background", not doing
    // nothing). Listening on the capture phase runs BEFORE Mousetrap sees the
    // event at all, and stopping propagation ourselves prevents the native
    // handler from also firing afterwards for the keys we've taken over.
    const handleKeydown = (event: KeyboardEvent): void => {
        if (isEditableTarget(event.target)) return;

        if (event.code === 'NumpadAdd' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            triggerDrawMode(store, dispatch);
            return;
        }

        if (event.code === 'NumpadSubtract' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            triggerDeleteActivatedObject(store, dispatch, event.shiftKey);
            return;
        }

        if (event.code === 'NumpadDivide' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            triggerFrameNavigation(store, dispatch, 'prev');
            return;
        }

        if (event.code === 'NumpadMultiply' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            triggerFrameNavigation(store, dispatch, 'next');
            return;
        }

        const index = findShortcutIndex(event);
        if (index === -1) return;
        const label = currentOrderedLabels[index];
        if (!label) return;
        event.preventDefault();
        event.stopPropagation();
        applyLabel(store, dispatch, label);
    };

    window.addEventListener('keydown', handleKeydown, { capture: true });

    // Exposed console API so each signed-in user can personalize SLOT_RANKS
    // from their own browser, without editing this file or rebuilding -
    // see the comment on SLOT_RANKS_STORAGE_PREFIX above for usage.
    (window as any).cvatLabelShortcuts = {
        setSlotRanks(ranks: number[]): void {
            const userId = store.getState().auth.user?.id ?? null;
            if (userId === null) {
                // eslint-disable-next-line no-console
                console.error('[label-shortcuts] No signed-in user - cannot save a personal SLOT_RANKS override.');
                return;
            }
            if (!isValidSlotRanks(ranks)) {
                // eslint-disable-next-line no-console
                console.error('[label-shortcuts] Invalid ranks - expected a non-empty array of positive integers.');
                return;
            }
            writeUserSlotRanksOverride(userId, ranks);
            // eslint-disable-next-line no-console
            console.info(`[label-shortcuts] Personal SLOT_RANKS saved for user ${userId}.`);
            if (lastHandledProjectId !== null) recomputeCurrentOrderedLabels(lastHandledProjectId, userId);
        },
        getSlotRanks(): number[] {
            return effectiveSlotRanks(store.getState().auth.user?.id ?? null);
        },
        resetSlotRanks(): void {
            const userId = store.getState().auth.user?.id ?? null;
            if (userId === null) return;
            clearUserSlotRanksOverride(userId);
            // eslint-disable-next-line no-console
            console.info(`[label-shortcuts] Personal SLOT_RANKS override removed for user ${userId}.`);
            if (lastHandledProjectId !== null) recomputeCurrentOrderedLabels(lastHandledProjectId, userId);
        },
    };

    return {
        name: 'Label shortcuts (alphabetical, per project)',
        destructor: () => {
            window.removeEventListener('keydown', handleKeydown, { capture: true });
            lastHandledProjectId = null;
            lastRankedLabels = [];
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
                lastRankedLabels = resolveLabelOrder(projectId, eligibleLabels);
                const userId = store.getState().auth.user?.id ?? null;
                recomputeCurrentOrderedLabels(projectId, userId);
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
