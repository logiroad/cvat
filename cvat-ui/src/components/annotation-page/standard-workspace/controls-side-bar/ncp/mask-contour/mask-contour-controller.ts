// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/**
 * Mask-contour controller — the canvas-DOM side of the NCP "show mask contours"
 * toggle.
 *
 * It is deliberately self-contained (no React, no imports from cvat-canvas) so the
 * whole feature lives inside the `ncp/` folder without touching core code:
 *
 *   1. Find the `#cvat_canvas_content` SVG.
 *   2. Inject the two SVG `<filter>`s (mask-with-outline / mask-contour-only) into
 *      its `<defs>` and a `<style>` element (once each).
 *   3. Find the mask `<image class="cvat_canvas_shape">` elements.
 *   4. Add / remove the `contour-highlight` / `contour-only` classes on them.
 *
 * Masks are re-created by the canvas whenever their points change or the frame
 * changes, which drops any class we added. Rather than patching the canvas we
 * listen to its own `canvas.setup` event (dispatched on `canvasInstance.html()`
 * after every objects re-render) and reapply the active class to the fresh
 * `<image>` nodes.
 */

import { Canvas } from 'cvat-canvas-wrapper';

export type ContourMode = 'none' | 'highlight' | 'only';

const CONTENT_ID = 'cvat_canvas_content';
const HIGHLIGHT_CLASS = 'contour-highlight';
const ONLY_CLASS = 'contour-only';
const DEFS_MARKER_ID = 'ncp-mask-contour-defs';
const STYLE_ID = 'ncp-mask-contour-style';
const SVG_NS = 'http://www.w3.org/2000/svg';

// The active mode is kept at module scope so both the `canvas.setup` listener and
// `applyContourMode` share a single source of truth.
let currentMode: ContourMode = 'none';

// Two filters that turn a mask image into (1) a faded mask with an opaque outline
// and (2) an opaque outline only. The outline is drawn in the mask's OWN colour
// (the label colour carried per-pixel in the image) rather than a fixed colour:
// we dilate the coloured mask outward, force those pixels fully opaque, then keep
// only the ring that lies outside the original mask.
const FILTERS_MARKUP = `
<g id="${DEFS_MARKER_ID}">
    <filter id="mask-with-outline" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
        <feMorphology in="SourceGraphic" operator="dilate" radius="4" result="expanded-graphic" />
        <feComponentTransfer in="expanded-graphic" result="opaque-expanded">
            <feFuncA type="linear" slope="100" />
        </feComponentTransfer>
        <feComposite in="opaque-expanded" in2="SourceAlpha" operator="out" result="colored-outline" />
        <feComponentTransfer in="SourceGraphic" result="faded-mask">
            <feFuncA type="linear" slope="0.05" />
        </feComponentTransfer>
        <feMerge>
            <feMergeNode in="colored-outline" />
            <feMergeNode in="faded-mask" />
        </feMerge>
    </filter>
    <filter id="mask-contour-only" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
        <feMorphology in="SourceGraphic" operator="dilate" radius="4" result="expanded-graphic" />
        <feComponentTransfer in="expanded-graphic" result="opaque-expanded">
            <feFuncA type="linear" slope="100" />
        </feComponentTransfer>
        <feComposite in="opaque-expanded" in2="SourceAlpha" operator="out" />
    </filter>
</g>`;

// The `opacity`/`transition` overrides are scoped to the contour classes so masks
// in the normal (no-contour) state keep their original rendered opacity. The
// sidebar-button sizing is carried here too so no shared .scss file needs editing.
const STYLE_MARKUP = `
.cvat_canvas_shape.${HIGHLIGHT_CLASS},
.cvat_canvas_shape.${ONLY_CLASS} {
    opacity: 1;
    transition: filter 150ms ease, opacity 150ms ease;
}
.cvat_canvas_shape.${HIGHLIGHT_CLASS} { filter: url("#mask-with-outline"); }
.cvat_canvas_shape.${ONLY_CLASS} { filter: url("#mask-contour-only"); }

.cvat-mask-contour-control {
    border-radius: 4px;
    transition: all 0.25s;
    transform: scale(0.65);
    padding: 2px;
}
.cvat-mask-contour-control:hover:not(.cvat-disabled-canvas-control) {
    background: #d9d9d9;
    transform: scale(0.75);
}
.cvat-mask-contour-control:active:not(.cvat-disabled-canvas-control) {
    transform: scale(0.65);
}
.cvat-mask-contour-control > svg {
    width: 32px;
    height: 32px;
}`;

function getContent(): SVGSVGElement | null {
    return window.document.getElementById(CONTENT_ID) as unknown as (SVGSVGElement | null);
}

/**
 * Injects the `<style>` (filter CSS + sidebar-button sizing) into `<head>`. This
 * does not depend on the canvas being present, so the button is correctly sized
 * even if the control mounts before the canvas SVG exists. Guarded by a marker id
 * so repeated calls never produce duplicates.
 */
function ensureStyle(): void {
    if (!window.document.getElementById(STYLE_ID)) {
        const style = window.document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_MARKUP;
        window.document.head.appendChild(style);
    }
}

/**
 * Injects the filter `<defs>` into the given content SVG. Guarded by a marker id
 * so repeated calls (and canvas re-creation on a new job) never duplicate them.
 */
function ensureDefs(content: SVGSVGElement): void {
    if (content.querySelector(`#${DEFS_MARKER_ID}`)) return;

    let defs = content.querySelector('defs');
    if (!defs) {
        defs = window.document.createElementNS(SVG_NS, 'defs');
        content.insertBefore(defs, content.firstChild);
    }
    // Parse the namespaced markup and import the resulting nodes into <defs>.
    const parsed = new DOMParser().parseFromString(
        `<svg xmlns="${SVG_NS}">${FILTERS_MARKUP}</svg>`,
        'image/svg+xml',
    );
    const group = parsed.querySelector(`#${DEFS_MARKER_ID}`);
    if (group) {
        defs.appendChild(window.document.importNode(group, true));
    }
}

/** Reapplies the current mode's class to every mask `<image>` in the canvas. */
function reapply(): void {
    // Button sizing must be available regardless of canvas readiness.
    ensureStyle();

    const content = getContent();
    if (!content) return;
    ensureDefs(content);

    const images = content.querySelectorAll('image.cvat_canvas_shape');
    images.forEach((image) => {
        image.classList.remove(HIGHLIGHT_CLASS, ONLY_CLASS);
        if (currentMode === 'highlight') {
            image.classList.add(HIGHLIGHT_CLASS);
        } else if (currentMode === 'only') {
            image.classList.add(ONLY_CLASS);
        }
    });
}

/** Sets the active contour mode and applies it to the current mask images. */
export function applyContourMode(mode: ContourMode): void {
    currentMode = mode;
    reapply();
}

/**
 * Starts listening for canvas re-renders so the active mode survives frame
 * changes and mask edits. Returns a disposer that removes the listener and clears
 * every contour class — call it on unmount.
 */
export function activateContour(canvasInstance: Canvas): () => void {
    const wrapper = canvasInstance.html();
    const onSetup = (): void => reapply();
    wrapper.addEventListener('canvas.setup', onSetup);
    reapply();

    return (): void => {
        wrapper.removeEventListener('canvas.setup', onSetup);
        currentMode = 'none';
        reapply();
    };
}
