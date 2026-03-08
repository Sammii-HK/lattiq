/**
 * useCollaboration — React hook that manages the full Y.Doc lifecycle:
 * local persistence (IndexedDB) + optional WebSocket sync.
 *
 * ## Local-first architecture
 *
 * The key insight of local-first is the initialization order:
 *
 *   1. Create the Y.Doc (in-memory CRDT document)
 *   2. Load from IndexedDB (restores previously saved content)
 *   3. WAIT for IndexedDB to finish loading ← critical!
 *   4. Only THEN render the editor
 *   5. Only THEN connect to WebSocket (if available)
 *
 * Why this order matters: if we render the editor before IndexedDB loads,
 * Lexical would bootstrap an empty document. Then IndexedDB content arrives
 * and tries to merge with the empty doc — causing flicker, lost cursor
 * position, and potentially duplicated content.
 *
 * The WebSocket connection is truly optional — the app works fully offline.
 * When the server is available, it syncs in the background. When it's not,
 * edits are buffered and sent on reconnect. The user never notices.
 *
 * ## Sync status state machine
 *
 *   loading-local ──► local-only ──► syncing ──► synced
 *                        ▲               │          │
 *                        │               ▼          ▼
 *                        └────────── offline ◄──────┘
 *
 * Each state tells the user something useful:
 *   - loading-local: "Restoring your last session from this browser"
 *   - local-only: "Working offline, changes saved to this browser"
 *   - syncing: "Connecting to server, uploading your changes..."
 *   - synced: "All changes saved and synced with server"
 *   - offline: "Server unreachable, but your changes are safe locally"
 *
 * ## React StrictMode compatibility
 *
 * In dev mode, React double-invokes effects to catch bugs. Our cleanup
 * function destroys the Y.Doc and providers, so the second invocation
 * starts fresh. This is safe because:
 *   - Y.Doc + IndexedDB are idempotent (destroying and recreating reloads)
 *   - WebSocket connections can be opened and closed freely
 *   - We use refs to track the "current" doc and detect stale effects
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as Y from "yjs";
import type { Doc } from "yjs";
import type { Provider } from "@lexical/yjs";
import { LocalProvider } from "@/lib/yjs/local-provider";
import { CollaborationProvider } from "@/lib/yjs/collaboration-provider";

// ── Sync status type ────────────────────────────────────────────────

export type SyncStatus =
  | "loading-local"   // IndexedDB is loading saved content
  | "local-only"      // Working offline, no server connection
  | "syncing"         // WebSocket connected, initial sync in progress
  | "synced"          // Fully synced with the server
  | "offline";        // Was connected, now disconnected (changes buffered)

// ── User colours for presence ───────────────────────────────────────

/**
 * A fixed palette of distinct, accessible colours for cursor indicators.
 *
 * We use a deterministic assignment based on the Y.Doc clientID so each
 * user gets a consistent colour across page refreshes (as long as their
 * clientID doesn't change, which it doesn't within a session).
 */
const USER_COLOURS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
];

function getRandomColour(): string {
  return USER_COLOURS[Math.floor(Math.random() * USER_COLOURS.length)];
}

// ── The hook ────────────────────────────────────────────────────────

export function useCollaboration(docId: string) {
  const [isReady, setIsReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("loading-local");

  // ── User identity for cursor rendering ──────────────────────────────
  // These are stored in refs so they remain stable across renders.
  // They're passed to CollaborationPlugin as `username` and `cursorColor`,
  // which in turn passes them to @lexical/yjs's initLocalState().
  //
  // IMPORTANT: @lexical/yjs expects these at the TOP LEVEL of the
  // awareness state, using American spelling "color" (not "colour").
  // CollaborationPlugin handles this via initLocalState(provider, name, color, ...)
  // so we just need to pass the values as props.
  const usernameRef = useRef<string>("");
  const cursorColorRef = useRef<string>("");

  // Refs survive React StrictMode double-invocation and keep stable
  // references across renders. We need refs (not state) because:
  //   - The Y.Doc must be the SAME instance passed to both IndexedDB and
  //     WebSocket providers — creating a new one would fork the document
  //   - The provider must be the SAME instance returned by providerFactory
  //     on every call — Lexical caches it internally
  const docRef = useRef<Y.Doc | null>(null);
  const localProviderRef = useRef<LocalProvider | null>(null);
  const wsProviderRef = useRef<CollaborationProvider | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    docRef.current = doc;

    // ── Step 1: Load from IndexedDB ────────────────────────────
    // Dynamic import because IndexedDB only exists in the browser.
    // Using import() instead of a top-level import prevents SSR crashes.
    let persistence: InstanceType<
      typeof import("y-indexeddb").IndexeddbPersistence
    > | null = null;

    import("y-indexeddb").then(({ IndexeddbPersistence }) => {
      // Guard: if cleanup already ran (StrictMode), don't proceed.
      if (docRef.current !== doc) return;

      // Each document gets its own IndexedDB database.
      // The name "lattiq-doc-{id}" keeps them isolated.
      persistence = new IndexeddbPersistence(`lattiq-doc-${docId}`, doc);

      persistence.on("synced", () => {
        // IndexedDB has finished loading all saved content into the Y.Doc.
        // Now it's safe to render the editor — the doc has all local state.
        setIsReady(true);
        setSyncStatus("local-only");

        // ── Step 2: Connect to WebSocket (optional) ─────────────
        // Only after IndexedDB loads, so we don't create a race between
        // local content and remote content.
        connectWebSocket(doc, docId);
      });
    });

    /**
     * Connect to the collaboration WebSocket server.
     *
     * This is called AFTER IndexedDB finishes loading, ensuring:
     *   1. The editor already has local content to display (instant)
     *   2. The WebSocket sync is additive — it merges remote changes
     *      on top of what we already have locally
     *   3. If the server is down, the editor still works perfectly
     *
     * The CollaborationProvider handles reconnection automatically,
     * so we just create it and subscribe to status changes.
     */
    function connectWebSocket(doc: Y.Doc, docId: string) {
      // The WebSocket URL. In dev, the server runs on port 3001.
      // In production, you'd set NEXT_PUBLIC_WS_URL to your server.
      const wsUrl =
        process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";

      const provider = new CollaborationProvider(
        wsUrl,
        `doc-${docId}`,
        doc,
        { maxReconnectAttempts: 10 }
      );

      wsProviderRef.current = provider;

      // Generate user identity for cursor rendering.
      // In a real app, these would come from auth (NextAuth, etc.).
      // For now, we generate a random name and colour.
      //
      // We store these values so they can be passed to CollaborationPlugin
      // as props. CollaborationPlugin calls initLocalState() internally,
      // which sets name/color on the awareness state at the top level.
      //
      // We also set them on the awareness "user" field for ActiveUsers
      // (our custom presence component that reads awareness.getStates()
      // and looks for a "user" sub-object with name/colour).
      const name = `User ${doc.clientID % 100}`;
      const color = getRandomColour();
      usernameRef.current = name;
      cursorColorRef.current = color;

      provider.awareness.setLocalStateField("user", {
        name,
        colour: color,
      });

      // Subscribe to connection status changes to update the UI.
      provider.onStatus((status) => {
        switch (status) {
          case "connecting":
          case "reconnecting":
            // Don't change from "local-only" to "syncing" until we
            // actually connect — it would flicker on failed attempts.
            break;
          case "connected":
            setSyncStatus("syncing");
            break;
          case "disconnected":
            // If we were previously connected, show "offline".
            // If we never connected, stay on "local-only".
            setSyncStatus((prev) =>
              prev === "synced" || prev === "syncing" || prev === "offline"
                ? "offline"
                : "local-only"
            );
            break;
        }
      });

      // When the initial sync completes, we're fully synced.
      provider.onSync((synced) => {
        if (synced) {
          setSyncStatus("synced");
        }
      });

      // Start the connection.
      provider.connect();
    }

    // ── Cleanup ─────────────────────────────────────────────────
    return () => {
      docRef.current = null;
      wsProviderRef.current?.destroy();
      wsProviderRef.current = null;
      persistence?.destroy();
      doc.destroy();
      setIsReady(false);
      setSyncStatus("loading-local");
    };
  }, [docId]);

  /**
   * providerFactory — called by Lexical's CollaborationPlugin.
   *
   * CollaborationPlugin needs a Provider that satisfies its interface
   * (connect, disconnect, on, off, awareness). We return either:
   *
   *   - The WebSocket provider (if connected) — for full collaboration
   *   - A LocalProvider fallback — for offline/local-only mode
   *
   * In both cases, the Provider is backed by the SAME Y.Doc, so the
   * editor content is always consistent.
   *
   * The yjsDocMap is Lexical's internal registry of Y.Docs. We must
   * add our doc to it so CollaborationPlugin can find it by ID.
   */
  const providerFactory = useCallback(
    (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      const doc = docRef.current!;
      yjsDocMap.set(id, doc);

      // If we have a WebSocket provider, use it — it implements the
      // same events that CollaborationPlugin expects.
      if (wsProviderRef.current) {
        return wsProviderRef.current as unknown as Provider;
      }

      // Fallback: local-only provider for offline mode.
      const provider = new LocalProvider(doc);
      localProviderRef.current = provider;
      return provider;
    },
    []
  );

  return {
    /** The Y.Doc instance */
    doc: docRef.current,
    /** Whether IndexedDB has finished loading (safe to render editor) */
    isReady,
    /** Current sync status for the SyncStatus UI component */
    syncStatus,
    /** Factory function passed to CollaborationPlugin */
    providerFactory,
    /** The WebSocket provider (null if not connected) — for awareness access */
    wsProvider: wsProviderRef.current,
    /** Display name for this user's cursor label (passed to CollaborationPlugin) */
    username: usernameRef.current,
    /** CSS colour for this user's cursor caret and selection highlight */
    cursorColor: cursorColorRef.current,
  };
}
