/**
 * CollaborativeEditor — The main rich text editor component.
 *
 * ## Architecture
 *
 * This uses Lexical (Meta's extensible text editor framework) with:
 *   - RichTextPlugin: Core rich text editing (bold, italic, headings, etc.)
 *   - HistoryPlugin: Undo/redo stack
 *   - ListPlugin: Bullet and numbered lists
 *   - LinkPlugin: Clickable hyperlinks
 *   - ToolbarPlugin: Our custom formatting toolbar
 *
 * ## Why HistoryPlugin (not CollaborationPlugin)?
 *
 * CollaborationPlugin bridges Lexical ↔ Yjs for real-time CRDT-based
 * collaboration. However, @lexical/yjs imports yjs which imports lib0,
 * and lib0's binary encoding tables cause "Unexpected end of array"
 * errors during webpack module evaluation in Next.js.
 *
 * For now we use HistoryPlugin (Lexical's built-in undo/redo) which
 * gives us a fully functional editor without the Yjs dependency.
 * Collaboration support will be re-added once the lib0/webpack
 * compatibility issue is resolved.
 *
 * ## How Lexical works (learning reference)
 *
 * Lexical uses a node-based document model (like a lightweight DOM):
 *   - RootNode: The top-level container
 *   - ParagraphNode: A block of text
 *   - TextNode: Inline text with formatting flags
 *   - HeadingNode, ListNode, etc.: Specialised block types
 *
 * Plugins extend the editor by listening to commands and transforms.
 * Each plugin registers itself with the editor instance provided by
 * LexicalComposer via React context.
 *
 * ## Why key={docId}?
 *
 * When navigating between documents, React's key prop forces a full
 * unmount/remount of the editor, ensuring no stale state leaks.
 */

"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode, AutoLinkNode } from "@lexical/link";

import editorTheme from "./EditorTheme";
import ToolbarPlugin from "./ToolbarPlugin";
import { bootstrapGettingStarted } from "@/lib/initial-content";

function onError(error: Error) {
  console.error("Lexical error:", error);
}

export default function CollaborativeEditor({ docId }: { docId: string }) {
  const initialConfig = {
    namespace: "LattiqEditor",
    theme: editorTheme,
    onError,
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      CodeHighlightNode,
      LinkNode,
      AutoLinkNode,
    ],
    // Bootstrap the "Getting Started" doc with welcome content.
    // Other documents start with an empty editor (undefined = default).
    editorState:
      docId === "getting-started" ? bootstrapGettingStarted : undefined,
  };

  return (
    <LexicalComposer key={docId} initialConfig={initialConfig}>
      <div className="editor-container">
        <ToolbarPlugin />
        <div className="editor-inner">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="editor-input" />
            }
            placeholder={
              <div className="editor-placeholder">Start writing...</div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          {/* HistoryPlugin provides undo (Cmd+Z) and redo (Cmd+Shift+Z).
              It tracks editor state changes as discrete history entries. */}
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
        </div>
      </div>
    </LexicalComposer>
  );
}
