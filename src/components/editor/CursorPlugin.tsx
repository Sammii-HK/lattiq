/**
 * CursorPlugin — Provides a positioned container for remote user cursors.
 *
 * ## Why this plugin exists
 *
 * Lexical's CollaborationPlugin has built-in cursor rendering via @lexical/yjs.
 * It creates DOM elements for each remote user's cursor (a coloured caret line
 * and a name label) and positions them absolutely based on the remote user's
 * selection coordinates.
 *
 * However, these cursor elements need a *container* to be rendered into.
 * By default, CollaborationPlugin portals the cursors container to
 * `document.body`. This causes a problem: the cursor positions are calculated
 * relative to the cursors container's offsetParent (see updateCursor in
 * @lexical/yjs). When the container is on `document.body`, the cursors appear
 * at the correct absolute position on the page — but they don't scroll with
 * the editor, and they sit outside the editor's visual boundary.
 *
 * ## How we fix it
 *
 * CollaborationPlugin accepts a `cursorsContainerRef` prop. When provided,
 * it portals the cursor elements into that ref's element instead of
 * `document.body`. We create a `<div>` that:
 *
 *   1. Is positioned inside the editor's content area (via the editor-inner wrapper)
 *   2. Uses `position: relative` so it becomes the offsetParent for cursor elements
 *   3. Has `pointer-events: none` so it doesn't intercept clicks/selections
 *   4. Sits at the same position as the editor content (so cursor coordinates align)
 *
 * The cursor elements inside use `position: absolute` with `top`/`left` values
 * calculated by @lexical/yjs relative to this container. Because the container
 * is co-located with the editor content, the cursors appear in the right place.
 *
 * ## What @lexical/yjs does under the hood
 *
 * When a remote user moves their cursor, here's the flow:
 *
 *   1. Remote user's editor broadcasts their selection via Yjs Awareness
 *      (the selection is encoded as Yjs RelativePositions — which survive
 *      concurrent edits, unlike absolute offsets)
 *
 *   2. Our Awareness instance receives the update and fires an 'update' event
 *
 *   3. CollaborationPlugin's awareness listener calls syncCursorPositions()
 *
 *   4. syncCursorPositions() iterates over all awareness states, and for each
 *      remote user:
 *      a. Converts their RelativePosition back to an absolute position in our doc
 *      b. Creates a Lexical Range from the anchor/focus positions
 *      c. Gets the bounding rectangles of that range via Range.getClientRects()
 *      d. Creates/updates DOM elements positioned at those rectangles
 *
 *   5. The caret (a 1px-wide coloured bar) is appended to the last selection
 *      rectangle, with a name label positioned above it
 *
 *   6. Selection highlights (translucent coloured rectangles) are created for
 *      each line of the selection
 *
 * ## Why RelativePositions instead of absolute offsets?
 *
 * In a collaborative editor, two users might type at the same time. If user A
 * has their cursor at position 5, and user B inserts 3 characters before
 * position 5, user A's cursor should now be at position 8. Absolute offsets
 * would require constant recalculation.
 *
 * Yjs RelativePositions solve this elegantly: they reference a specific item
 * in the CRDT sequence (identified by its unique ID), not an absolute offset.
 * When items are inserted or deleted around it, the relative position still
 * points to the same logical location. The conversion back to an absolute
 * position happens on read (when rendering the cursor).
 *
 * ## Awareness state shape
 *
 * @lexical/yjs expects the awareness local state to have this shape:
 *
 *   {
 *     name: string,          // Displayed in the cursor label
 *     color: string,         // CSS colour for the caret and selection highlight
 *     focusing: boolean,     // Whether this user's editor is focused
 *     anchorPos: RelativePosition | null,  // Start of selection
 *     focusPos: RelativePosition | null,   // End of selection
 *     awarenessData: object  // Any extra data (avatar URL, role, etc.)
 *   }
 *
 * IMPORTANT: @lexical/yjs uses American spelling "color", not British "colour".
 * The name and color are set at the TOP LEVEL of the awareness state (not nested
 * under a "user" key). CollaborationPlugin handles this internally via
 * initLocalState() when you pass `username` and `cursorColor` props.
 *
 * ## Cursor DOM structure (created by @lexical/yjs)
 *
 * For a collapsed cursor (no selection range):
 *
 *   <span style="position:absolute; ...">              ← selection rect
 *     <span style="background-color:${color}; ...">    ← highlight (0-width)
 *     </span>
 *     <span style="...width:1px; background:${color}"> ← caret (thin bar)
 *       <span style="...background:${color}">          ← name label
 *         User 42
 *       </span>
 *     </span>
 *   </span>
 *
 * For a range selection, multiple selection rects are created (one per line),
 * each with a translucent background. The caret is appended to the last one.
 *
 * All styles are inline (set via element.style.cssText in createCursorSelection
 * and updateCursor). We add supplementary CSS in globals.css for polish:
 * transitions, better label styling, z-index layering, etc.
 */

"use client";

import { useRef } from "react";

/**
 * CursorPlugin renders a container element for remote user cursors.
 *
 * ## Usage
 *
 * 1. Render <CursorPlugin /> inside the editor-inner div
 * 2. Pass the returned ref to CollaborationPlugin's cursorsContainerRef prop
 *
 * We separate the ref creation from the rendering so that CollaborativeEditor
 * can wire them together. The ref needs to be passed to CollaborationPlugin
 * as a prop, so the parent component creates it and passes it down.
 *
 * @param cursorsContainerRef - A React ref that CollaborationPlugin will
 *   portal cursor elements into. Created by the parent and shared.
 */
export default function CursorPlugin({
  cursorsContainerRef,
}: {
  cursorsContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    /**
     * This div becomes the offsetParent for all cursor elements.
     *
     * Key CSS properties:
     * - position: absolute + inset: 0 — fills the editor content area exactly,
     *   so cursor coordinates (calculated relative to this container) align
     *   with the text they point to
     * - pointer-events: none — clicks pass through to the editor beneath.
     *   Without this, the cursor container would intercept mouse events and
     *   break text selection
     * - z-index: 10 — above the text but below any modals/dropdowns. The caret
     *   elements inside use z-index: 10 relative to this container
     * - overflow: hidden — prevents cursor labels from extending outside the
     *   editor bounds (e.g. when a cursor is near the top edge, the label
     *   would poke out above the editor without this)
     */
    <div
      ref={cursorsContainerRef}
      className="cursors-container"
      aria-hidden="true" // Cursors are visual-only, not meaningful to screen readers
    />
  );
}

/**
 * useCursorsContainerRef — Creates the ref that wires CursorPlugin to CollaborationPlugin.
 *
 * ## Why a separate hook?
 *
 * The cursorsContainerRef needs to be:
 *   1. Created once (stable identity across renders)
 *   2. Passed to both <CursorPlugin> (which renders the DOM element)
 *      and <CollaborationPlugin> (which portals cursor elements into it)
 *
 * By extracting it into a hook, the parent component (CollaborativeEditor)
 * can create the ref and pass it to both children without managing the
 * ref lifecycle manually.
 *
 * ## How the portal works
 *
 * When CollaborationPlugin receives cursorsContainerRef:
 *   1. useYjsCursors() calls ReactDOM.createPortal(cursorDiv, ref.current)
 *   2. The cursor div gets portalled into our container instead of document.body
 *   3. @lexical/yjs sets binding.cursorsContainer = cursorDiv (via a React ref callback)
 *   4. updateCursor() positions cursor elements relative to cursorsContainer.offsetParent
 *   5. Since our container is position:absolute inside the editor, the coordinates align
 */
export function useCursorsContainerRef() {
  return useRef<HTMLDivElement | null>(null);
}
