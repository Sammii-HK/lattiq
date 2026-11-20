"use client";

/**
 * CollaborativeEditor: Lexical bound to a Yjs document.
 *
 *   LexicalComposer
 *   ├── ToolbarPlugin
 *   ├── RichTextPlugin, ListPlugin, LinkPlugin
 *   ├── CollaborationPlugin   Lexical <-> Y.Doc binding, Yjs undo/redo, cursors
 *   │     └── providerFactory -> CollaborationProvider (IndexedDB, seed, WebSocket)
 *   └── EditableWhenReady     read-only until local state has loaded
 *
 * CollaborationPlugin replaces HistoryPlugin: undo has to go through a Yjs
 * UndoManager so that undoing your edit never undoes someone else's.
 *
 * The editor only mounts in the browser, once the session exists. The
 * server renders the page shell and a skeleton, so there is nothing in the
 * editor for hydration to disagree about.
 */

import { useEffect, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { LexicalCollaboration } from "@lexical/react/LexicalCollaborationContext";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import type { Awareness } from "y-protocols/awareness";

import editorTheme from "./EditorTheme";
import ToolbarPlugin from "./ToolbarPlugin";
import CursorsContainer from "./CursorsContainer";
import ActiveUsers from "./ActiveUsers";
import SyncStatus from "./SyncStatus";
import EditorSkeleton from "./EditorSkeleton";
import { useCollaboration } from "@/hooks/useCollaboration";

function onError(error: Error) {
  console.error("Lexical error:", error);
}

const NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  AutoLinkNode,
];

/** Stops typing into an empty editor before IndexedDB and the seed have loaded. */
function EditableWhenReady({ ready }: { ready: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(ready);
  }, [editor, ready]);
  return null;
}

export default function CollaborativeEditor({ docId }: { docId: string }) {
  const { session, state, providerFactory } = useCollaboration(docId);
  const cursorsRef = useRef<HTMLDivElement | null>(null);

  if (!session) return <EditorSkeleton />;

  const initialConfig = {
    namespace: "LattiqEditor",
    theme: editorTheme,
    onError,
    nodes: NODES,
    // Content comes from the Y.Doc, never from Lexical's own initial state.
    editorState: null,
    editable: false,
  };

  return (
    <>
      <div className="editor-status-bar">
        <SyncStatus state={state.sync} />
        <ActiveUsers awareness={session.provider.awareness as Awareness} />
      </div>
      {/* Keyed by doc id so switching documents gets a fresh editor and binding. */}
      <LexicalCollaboration key={session.docId}>
        <LexicalComposer initialConfig={initialConfig}>
          <div className="editor-container" data-testid="editor" data-ready={state.localReady}>
            <ToolbarPlugin />
            <div className="editor-inner">
              <RichTextPlugin
                contentEditable={<ContentEditable className="editor-input" aria-label="Document" />}
                placeholder={
                  <div className="editor-placeholder">
                    {state.localReady ? "Start writing…" : "Opening…"}
                  </div>
                }
                ErrorBoundary={LexicalErrorBoundary}
              />
              <CursorsContainer containerRef={cursorsRef} />
              <CollaborationPlugin
                id={docId}
                providerFactory={providerFactory}
                shouldBootstrap={false}
                username={session.identity.name}
                cursorColor={session.identity.color}
                cursorsContainerRef={cursorsRef}
              />
              <EditableWhenReady ready={state.localReady} />
              <ListPlugin />
              <LinkPlugin />
            </div>
          </div>
        </LexicalComposer>
      </LexicalCollaboration>
    </>
  );
}
