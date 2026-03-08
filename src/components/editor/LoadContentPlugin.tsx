/**
 * LoadContentPlugin — Fetches seeded document content from the server
 * and populates the Lexical editor.
 *
 * ## How it works
 *
 * 1. On mount, fetches /api/doc/[id]/content (server-side route that
 *    reads .yjs files and extracts text — see route.ts for details)
 * 2. If content exists, creates Lexical nodes (headings, paragraphs)
 *    and inserts them into the editor
 * 3. If no content (404), does nothing — the editor stays empty
 *
 * ## Why a separate plugin?
 *
 * Lexical plugins are React components that access the editor via
 * useLexicalComposerContext(). This keeps content loading logic
 * separate from the editor setup (separation of concerns).
 *
 * ## Why not initialEditorState?
 *
 * initialEditorState runs synchronously during editor creation.
 * Fetching from an API is async. So we use a plugin that runs
 * after mount and updates the editor when data arrives.
 *
 * ## Lexical update rules
 *
 * All editor mutations must happen inside editor.update(() => { ... }).
 * The $ prefix on Lexical functions (like $getRoot, $createTextNode)
 * signals they can ONLY be called inside this update context — calling
 * them outside throws an error.
 */

"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
} from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";

/** Shape of each block returned by the /api/doc/[id]/content endpoint. */
interface ContentBlock {
  type: "heading" | "paragraph";
  tag?: string;
  text: string;
}

export default function LoadContentPlugin({ docId }: { docId: string }) {
  // useLexicalComposerContext() returns the editor instance from the
  // nearest LexicalComposer parent. This is how all Lexical plugins
  // get access to the editor without prop drilling.
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Only fetch for documents that might have seeded content.
    // The stub documents (getting-started, meeting-notes, etc.) use
    // initialEditorState instead.
    const seededDocs = [
      "the-yellow-wallpaper",
      "alice-in-wonderland",
      "pride-and-prejudice",
    ];
    if (!seededDocs.includes(docId)) return;

    let cancelled = false;

    async function loadContent() {
      try {
        const response = await fetch(`/api/doc/${docId}/content`);
        if (!response.ok || cancelled) return;

        const data = await response.json();
        const blocks: ContentBlock[] = data.blocks;

        if (!blocks || blocks.length === 0) return;

        // editor.update() wraps all mutations in a single transaction.
        // Lexical batches all the node changes and does a single DOM
        // reconciliation at the end — much more efficient than updating
        // the DOM for each node individually.
        editor.update(() => {
          const root = $getRoot();

          // Check if the editor already has content (user may have typed
          // while the fetch was in flight). If so, don't overwrite.
          const existingText = root.getTextContent();
          if (existingText.trim().length > 0) return;

          // Clear the default empty paragraph that Lexical creates.
          root.clear();

          // Create Lexical nodes from the server response.
          // Each block becomes either a HeadingNode or ParagraphNode
          // with a TextNode child containing the text.
          for (const block of blocks) {
            if (block.type === "heading") {
              const tag = (block.tag || "h2") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
              const heading = $createHeadingNode(tag);
              heading.append($createTextNode(block.text));
              root.append(heading);
            } else {
              const paragraph = $createParagraphNode();
              paragraph.append($createTextNode(block.text));
              root.append(paragraph);
            }
          }
        });
      } catch (error) {
        // Silently fail — the editor just stays empty.
        // This is intentional: seeded content is a nice-to-have,
        // not a requirement. The user can always type their own content.
        console.warn(`Failed to load seeded content for ${docId}:`, error);
      }
    }

    loadContent();

    // Cleanup: if the component unmounts before the fetch completes
    // (e.g. user navigates away), we set cancelled=true to prevent
    // updating an unmounted editor (which would cause a React warning).
    return () => {
      cancelled = true;
    };
  }, [docId, editor]);

  // Plugins don't render anything — they just run side effects.
  return null;
}
