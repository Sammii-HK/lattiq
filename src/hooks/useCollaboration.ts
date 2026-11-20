"use client";

/**
 * useCollaboration: open a document session for the lifetime of the editor.
 *
 * The session is created in an effect, not during render, so nothing
 * touches IndexedDB, sessionStorage or WebSocket on the server, and the
 * server-rendered HTML can't disagree with the first client render.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Doc } from "yjs";
import type { Provider } from "@lexical/yjs";
import { createDocSession, type DocSession, type DocSessionState } from "@/lib/yjs/doc-session";

const INITIAL: DocSessionState = { sync: "loading", localReady: false };
const noopSubscribe = () => () => {};

export function useCollaboration(docId: string) {
  const [session, setSession] = useState<DocSession | null>(null);

  useEffect(() => {
    const s = createDocSession(docId);
    setSession(s);
    return () => {
      s.destroy();
      setSession(null);
    };
  }, [docId]);

  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    () => session?.getState() ?? INITIAL,
    () => INITIAL
  );

  // Lexical's CollaborationPlugin asks for the provider by document id and
  // expects the Y.Doc to be registered in its map under the same id.
  const providerFactory = useCallback(
    (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      if (!session) throw new Error("providerFactory called before the session exists");
      yjsDocMap.set(id, session.doc);
      return session.provider as unknown as Provider;
    },
    [session]
  );

  return { session, state, providerFactory };
}
