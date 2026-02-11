/**
 * CollaborativeEditor — The main editor component backed by Yjs CRDTs.
 *
 * ## How it works
 *
 * 1. useCollaboration(docId) creates a Y.Doc, persists it to IndexedDB,
 *    and waits for IndexedDB to finish loading.
 * 2. Once ready (isReady=true), we render the Lexical editor.
 * 3. CollaborationPlugin binds Lexical ↔ Y.Doc: every Lexical edit becomes
 *    a Yjs operation, and vice versa.
 * 4. y-indexeddb (set up by useCollaboration) auto-persists every Yjs
 *    operation to IndexedDB in the background.
 *
 * ## Why CollaborationPlugin instead of HistoryPlugin?
 *
 * When Yjs manages the document, undo/redo must go through Yjs's UndoManager
 * (which understands CRDT operations) rather than Lexical's built-in history
 * (which snapshots entire editor states). CollaborationPlugin sets up
 * UndoManager automatically. Using both would create duplicate, conflicting
 * undo stacks.
 *
 * ## Why editorState: null?
 *
 * CollaborationPlugin populates the editor from the Y.Doc. If we also set an
 * initialEditorState, they'd conflict. Passing null tells LexicalComposer
 * "don't initialize any content — the collaboration plugin will handle it."
 *
 * ## Why key={docId}?
 *
 * When navigating between documents, we need a completely fresh Lexical
 * instance. React's key prop forces a full unmount/remount, ensuring no
 * stale state leaks between documents.
 */

"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { LexicalCollaboration } from "@lexical/react/LexicalCollaborationContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode, AutoLinkNode } from "@lexical/link";

import editorTheme from "./EditorTheme";
import ToolbarPlugin from "./ToolbarPlugin";
import SyncStatus from "./SyncStatus";
import { useCollaboration } from "@/hooks/useCollaboration";

function onError(error: Error) {
  console.error("Lexical error:", error);
}

export default function CollaborativeEditor({ docId }: { docId: string }) {
  const { isReady, syncStatus, providerFactory } = useCollaboration(docId);

  // Gate rendering until IndexedDB has loaded the Y.Doc.
  // This prevents CollaborationPlugin from bootstrapping an empty document
  // that would then conflict with persisted content arriving later.
  if (!isReady) {
    return (
      <div className="editor-container">
        <div className="editor-inner">
          <div className="editor-input" style={{ minHeight: 400 }}>
            <div className="editor-placeholder">Loading&hellip;</div>
          </div>
        </div>
      </div>
    );
  }

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
    // null: CollaborationPlugin manages editor state from the Y.Doc
    editorState: null,
  };

  return (
    <>
      <SyncStatus status={syncStatus} />
      {/* LexicalCollaboration provides the yjsDocMap context that
          CollaborationPlugin reads internally */}
      <LexicalCollaboration>
        {/* key={docId} forces a full remount when switching documents */}
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
              {/* CollaborationPlugin replaces HistoryPlugin — it binds
                  Lexical ↔ Y.Doc and sets up Yjs UndoManager for undo/redo */}
              <CollaborationPlugin
                id={docId}
                providerFactory={providerFactory}
                shouldBootstrap={true}
              />
              <ListPlugin />
              <LinkPlugin />
            </div>
          </div>
        </LexicalComposer>
      </LexicalCollaboration>
    </>
  );
}
