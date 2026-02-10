"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";

import editorTheme from "./EditorTheme";
import ToolbarPlugin from "./ToolbarPlugin";
import LocalStoragePlugin from "./LocalStoragePlugin";

function onError(error: Error) {
  console.error("Lexical error:", error);
}

export default function LexicalEditor({ docId }: { docId: string }) {
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
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
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
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
          <LocalStoragePlugin docId={docId} />
        </div>
      </div>
    </LexicalComposer>
  );
}
