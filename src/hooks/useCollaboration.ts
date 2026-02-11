/**
 * useCollaboration — React hook that manages the Y.Doc lifecycle, IndexedDB
 * persistence, and sync status for a given document.
 *
 * ## What it does
 *
 * 1. Creates a Y.Doc (the CRDT document that tracks every edit as an operation)
 * 2. Creates IndexeddbPersistence to auto-save/load from IndexedDB
 * 3. Waits for IndexedDB to finish loading before letting the editor render
 * 4. Returns a providerFactory that CollaborationPlugin calls to get a Provider
 * 5. Tracks sync status so the UI can show "loading" vs "saved locally"
 *
 * ## Why gate on isReady?
 *
 * IndexedDB loading is async. If we render the editor before the Y.Doc has
 * loaded its persisted content, CollaborationPlugin would bootstrap an empty
 * document — then the IndexedDB content would arrive and conflict. By waiting
 * for the 'synced' event, we ensure the Y.Doc already has all persisted
 * content before Lexical touches it.
 *
 * ## SSR guard
 *
 * IndexedDB doesn't exist on the server. We create IndexeddbPersistence
 * inside useEffect (which only runs on the client) to avoid SSR crashes.
 *
 * ## React StrictMode
 *
 * In development, StrictMode double-invokes effects. The cleanup function
 * destroys the Y.Doc and IndexedDB provider, so the second invocation
 * starts fresh. This is safe because Y.Doc + IndexedDB are idempotent —
 * destroying and recreating them just reloads from IndexedDB.
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as Y from "yjs";
import type { Doc } from "yjs";
import type { Provider } from "@lexical/yjs";
import { LocalProvider } from "@/lib/yjs/local-provider";

// The sync status state machine:
//   loading-local → local-only
// Phase 3 will add: local-only → syncing → synced
export type SyncStatus = "loading-local" | "local-only";

export function useCollaboration(docId: string) {
  const [isReady, setIsReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("loading-local");

  // Refs survive React StrictMode double-invocation and keep stable references
  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<LocalProvider | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    docRef.current = doc;

    // Dynamic import of y-indexeddb avoids SSR issues — IndexedDB only exists
    // in the browser. We use the DB name "lattiq-doc-{docId}" so each document
    // gets its own IndexedDB database.
    let persistence: InstanceType<
      typeof import("y-indexeddb").IndexeddbPersistence
    > | null = null;

    import("y-indexeddb").then(({ IndexeddbPersistence }) => {
      // Guard: if cleanup already ran (StrictMode), don't set up persistence
      if (docRef.current !== doc) return;

      persistence = new IndexeddbPersistence(`lattiq-doc-${docId}`, doc);

      persistence.on("synced", () => {
        // IndexedDB has finished loading all persisted content into the Y.Doc.
        // Now it's safe to render the editor.
        setIsReady(true);
        setSyncStatus("local-only");
      });
    });

    return () => {
      // Cleanup: destroy Y.Doc and IndexedDB provider
      docRef.current = null;
      persistence?.destroy();
      doc.destroy();
      setIsReady(false);
      setSyncStatus("loading-local");
    };
  }, [docId]);

  /**
   * providerFactory — called by CollaborationPlugin to get a Provider.
   *
   * CollaborationPlugin calls this function with the collaboration ID and
   * a yjsDocMap. We return our LocalProvider backed by the same Y.Doc.
   * The docMap is used by Lexical to track sub-documents (we add our doc to it).
   */
  const providerFactory = useCallback(
    (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      const doc = docRef.current!;
      yjsDocMap.set(id, doc);

      const provider = new LocalProvider(doc);
      providerRef.current = provider;
      return provider;
    },
    []
  );

  return {
    /** The Y.Doc instance — needed for initialEditorState checks */
    doc: docRef.current,
    /** Whether IndexedDB has finished loading (safe to render editor) */
    isReady,
    /** Current sync status for the SyncStatus UI component */
    syncStatus,
    /** Factory function passed to CollaborationPlugin */
    providerFactory,
  };
}
