"use client";

/**
 * CursorsContainer: where Lexical draws other people's carets and selections.
 *
 * CollaborationPlugin portals a div into this element, and @lexical/yjs
 * positions cursor spans inside it relative to the editor. It sits inside
 * `.editor-inner` (position: relative) and covers it exactly, with
 * pointer-events off so it never intercepts clicks or selection.
 */

import type { RefObject } from "react";

export default function CursorsContainer({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  return <div ref={containerRef} className="cursors-container" aria-hidden="true" />;
}
