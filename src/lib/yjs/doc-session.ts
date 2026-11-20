/**
 * doc-session.ts: everything one open document needs, wired together.
 *
 *   Y.Doc ── IndexeddbPersistence   (local-first: the source of truth on this device)
 *     │  └── seed file              (deterministic starting content, applied once)
 *     └──── CollaborationProvider   (sync + presence with the room server)
 *
 * The provider calls `loadLocal` on its first connect(). By then Lexical
 * has bound the editor to the Y.Doc and is observing it, so content loaded
 * from IndexedDB or the seed renders through the normal Yjs-to-Lexical
 * path. (Lexical's V1 binding never renders content that is already in the
 * Y.Doc when it binds, which is why loading can't happen earlier.)
 */

import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { CollaborationProvider, type ConnectionStatus } from "./collaboration-provider";
import { SEED_CLIENT_ID, SEEDED_DOC_IDS } from "../seed/books";

export type SyncState =
  | "loading" // reading IndexedDB / seed
  | "local" // no sync server configured; saved on this device
  | "connecting"
  | "syncing"
  | "synced"
  | "offline" // server unreachable; edits are saved locally and will merge
  | "error"; // the server refused the connection

export interface DocSessionState {
  sync: SyncState;
  localReady: boolean;
}

export interface Identity {
  name: string;
  color: string;
}

/** Timestamps (performance.now()) for the benchmark and debugging. */
export interface SessionTimings {
  localLoadedAt?: number;
  seedAppliedAt?: number;
  firstSyncedAt?: number;
  statusLog: { status: ConnectionStatus; at: number }[];
}

export interface DocSession {
  docId: string;
  doc: Y.Doc;
  provider: CollaborationProvider;
  identity: Identity;
  timings: SessionTimings;
  getState: () => DocSessionState;
  subscribe: (fn: () => void) => () => void;
  destroy: () => void;
}

const COLOURS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#0d9488", "#ea580c"];
const ADJECTIVES = ["Amber", "Brisk", "Calm", "Deft", "Eager", "Fleet", "Keen", "Lucid", "Merry", "Quiet"];
const ANIMALS = ["Badger", "Crane", "Finch", "Hare", "Heron", "Lynx", "Otter", "Owl", "Stoat", "Wren"];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** One identity per tab, kept across reloads so a refresh isn't a new person. */
function loadIdentity(): Identity {
  const key = "lattiq:identity";
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return JSON.parse(saved) as Identity;
  } catch {
    // storage unavailable
  }
  const identity = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLOURS) };
  try {
    sessionStorage.setItem(key, JSON.stringify(identity));
  } catch {
    // storage unavailable
  }
  return identity;
}

/**
 * Where the room server lives. NEXT_PUBLIC_WS_URL is inlined at build time.
 * In development we fall back to the local server; in a production build
 * without it, the editor runs local-only instead of retrying a localhost
 * socket that can never exist on a visitor's machine.
 */
export function syncServerUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured.replace(/\/$/, "");
  return process.env.NODE_ENV === "development" ? "ws://localhost:3001" : null;
}

export function roomNameFor(docId: string): string {
  return `doc-${docId}`;
}

/**
 * Apply the document's seed if it has never been applied here. The seed is
 * written with a fixed client ID, so "has been applied" is simply "the
 * document contains operations from that client". Even if two sources apply
 * it (this browser and the server), they're the same operations and merge
 * into one copy. We only skip it if someone has already written content
 * that didn't come from the seed.
 */
async function applySeed(doc: Y.Doc, docId: string): Promise<boolean> {
  if (!SEEDED_DOC_IDS.has(docId)) return false;
  if (doc.store.clients.has(SEED_CLIENT_ID)) return false;
  if (doc.get("root", Y.XmlText).length > 0) return false;

  const res = await fetch(`/seed/${docId}.yjs`);
  if (!res.ok) throw new Error(`seed ${docId}: HTTP ${res.status}`);
  const update = new Uint8Array(await res.arrayBuffer());
  Y.applyUpdate(doc, update, "seed");
  return true;
}

async function fetchToken(docId: string): Promise<string | null> {
  const res = await fetch(`/api/collab-token?doc=${encodeURIComponent(docId)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  const body = (await res.json()) as { token: string | null };
  return body.token;
}

export function createDocSession(docId: string): DocSession {
  const doc = new Y.Doc();
  const identity = loadIdentity();
  const timings: SessionTimings = { statusLog: [] };
  const listeners = new Set<() => void>();
  let persistence: IndexeddbPersistence | null = null;
  let state: DocSessionState = { sync: "loading", localReady: false };

  const setState = (next: Partial<DocSessionState>) => {
    state = { ...state, ...next };
    listeners.forEach((fn) => fn());
  };

  // Cache a token until shortly before it expires (tokens are "<exp>.<sig>").
  let cachedToken: { token: string | null; exp: number } | null = null;
  const getToken = async () => {
    if (cachedToken && cachedToken.exp - 60 > Date.now() / 1000) return cachedToken.token;
    const token = await fetchToken(docId);
    const exp = token ? Number(token.split(".")[0]) : Infinity;
    cachedToken = { token, exp };
    return token;
  };

  const provider = new CollaborationProvider(syncServerUrl(), roomNameFor(docId), doc, {
    getToken,
    loadLocal: async () => {
      persistence = new IndexeddbPersistence(`lattiq:${docId}`, doc);
      await persistence.whenSynced;
      timings.localLoadedAt = performance.now();
      try {
        if (await applySeed(doc, docId)) timings.seedAppliedAt = performance.now();
      } catch (err) {
        // Offline on a first visit: the server will supply the content later.
        console.warn("Lattiq: seed not applied", err);
      }
      setState({ localReady: true });
    },
  });

  provider.onStatus((status) => {
    timings.statusLog.push({ status, at: performance.now() });
    if (status === "synced" && timings.firstSyncedAt === undefined) {
      timings.firstSyncedAt = performance.now();
    }
    const sync: SyncState =
      status === "loading"
        ? "loading"
        : status === "idle"
          ? provider.hasServer()
            ? state.sync
            : "local"
          : status === "connected"
            ? "syncing"
            : status;
    setState({ sync });
  });

  const session: DocSession = {
    docId,
    doc,
    provider,
    identity,
    timings,
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy: () => {
      provider.destroy();
      persistence?.destroy();
      doc.destroy();
      listeners.clear();
    },
  };

  // Exposed for the Playwright tests and benchmarks; harmless in production.
  if (typeof window !== "undefined") {
    (window as unknown as { __lattiq?: DocSession }).__lattiq = session;
  }

  return session;
}
