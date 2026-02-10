"use client";

import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

const DEBOUNCE_MS = 500;

function getStorageKey(docId: string) {
  return `lattiq-doc-${docId}`;
}

export default function LocalStoragePlugin({ docId }: { docId: string }) {
  const [editor] = useLexicalComposerContext();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load saved state on mount (client-only)
  useEffect(() => {
    const key = getStorageKey(docId);
    const saved = localStorage.getItem(key);
    if (saved) {
      const editorState = editor.parseEditorState(saved);
      editor.setEditorState(editorState);
    }
  }, [editor, docId]);

  // Save on change with debounce
  useEffect(() => {
    const key = getStorageKey(docId);
    return editor.registerUpdateListener(
      ({ editorState, dirtyElements, dirtyLeaves }) => {
        // Don't save if nothing changed
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          localStorage.setItem(key, JSON.stringify(editorState.toJSON()));
        }, DEBOUNCE_MS);
      }
    );
  }, [editor, docId]);

  return null;
}
