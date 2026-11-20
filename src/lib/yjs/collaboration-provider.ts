/**
 * CollaborationProvider: a WebSocket provider for Yjs that Lexical's
 * CollaborationPlugin can drive.
 *
 * ## Why a custom provider instead of y-websocket?
 *
 * It owns the whole local-first lifecycle in one place:
 *   1. load the document from IndexedDB (and the seed, if any) *before*
 *      touching the network, via the `loadLocal` hook;
 *   2. open the socket, exchange state vectors and stream updates;
 *   3. reconnect forever with capped exponential backoff, reacting to the
 *      browser's online/offline events and a heartbeat;
 *   4. fetch a short-lived signed token for the room before each connect.
 *
 * ## How the Yjs sync protocol works
 *
 *   Step 1 "here is what I have": each side sends its state vector, a
 *          compact { clientID: clock } summary of the operations it holds.
 *   Step 2 "here is what you are missing": the other side replies with
 *          only the operations not covered by that state vector.
 *
 * Both sides do this on connect, then stream incremental updates.
 *
 * ## Offline edits
 *
 * There is deliberately no in-memory queue of offline updates. Every edit
 * is written to IndexedDB by y-indexeddb, and on reconnect the server's
 * step 1 makes us reply with a step 2 containing everything it lacks. That
 * covers edits made before a reload, which an in-memory queue would lose.
 *
 * ## Message types on the wire (first VarUint of every frame)
 *
 *   0 MSG_SYNC             y-protocols sync (step 1, step 2, update)
 *   1 MSG_AWARENESS        y-protocols awareness (cursors, names)
 *   3 MSG_QUERY_AWARENESS  ask for every current awareness state
 *   4 MSG_PING             heartbeat; the server echoes it back
 *
 * ## Why connect() is synchronous
 *
 * Lexical calls connect() on mount and disconnect() on unmount, and React
 * StrictMode runs that pair twice in development. If connect() returned a
 * promise, Lexical would chain disconnect() onto it and could close the
 * socket opened by the *second* connect(). Instead, connect() just records
 * intent (`shouldConnect`) and the async work checks that flag.
 */

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_PING = 4;

/** Close codes the server uses to reject a connection outright. */
export const CLOSE_INVALID_ROOM = 4400;
export const CLOSE_UNAUTHORISED = 4401;

export type ConnectionStatus =
  | "idle" // not asked to connect yet, or disconnected on purpose
  | "loading" // loading local state before going online
  | "connecting"
  | "connected" // socket open, waiting for the server's step 2
  | "synced" // socket open and the initial exchange is complete
  | "offline" // lost the connection, retrying with backoff
  | "error"; // the server refused us; not retrying

export interface ProviderOptions {
  awareness?: awarenessProtocol.Awareness;
  /** Runs once, before the first socket is opened. */
  loadLocal?: () => Promise<void>;
  /** Returns a token for the room, or null when the server is open. */
  getToken?: () => Promise<string | null>;
  initialBackoff?: number;
  maxBackoff?: number;
  heartbeatInterval?: number;
}

type EventType = "sync" | "status" | "update" | "reload";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventCallback = (...args: any[]) => void;

export class CollaborationProvider {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;

  private ws: WebSocket | null = null;
  private url: string | null;
  private roomName: string;
  private options: ProviderOptions;

  private shouldConnect = false;
  private localReady: Promise<void> | null = null;
  private status: ConnectionStatus = "idle";
  private synced = false;
  private reconnectAttempts = 0;
  private authFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private destroyed = false;

  private listeners = new Map<EventType, Set<EventCallback>>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  /**
   * @param url WebSocket base URL, or null for a purely local document
   *            (no sync server configured). Local persistence still runs.
   */
  constructor(url: string | null, roomName: string, doc: Y.Doc, options: ProviderOptions = {}) {
    this.url = url;
    this.roomName = roomName;
    this.doc = doc;
    this.options = options;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);

    this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
  }

  // ── Lifecycle (called by Lexical) ───────────────────────────────────

  connect(): void {
    if (this.destroyed) return;
    this.shouldConnect = true;

    if (!this.localReady) {
      this.setStatus("loading");
      this.localReady = (this.options.loadLocal?.() ?? Promise.resolve()).catch((err) => {
        // A failed local load (private mode, quota) must not block sync.
        console.warn("Lattiq: local load failed", err);
      });
    }

    this.localReady.then(() => {
      if (!this.shouldConnect || this.destroyed) return;
      // Lexical waits for 'sync' before treating the document as live. With
      // no server, local state is all there is, so we are synced already.
      if (!this.url) {
        this.setSynced(true);
        this.setStatus("idle");
        return;
      }
      this.openSocket();
    });
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.clearReconnect();
    this.closeSocket();
    if (this.status !== "error") this.setStatus("idle");
  }

  destroy(): void {
    this.disconnect();
    this.destroyed = true;
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }

  // ── Socket ──────────────────────────────────────────────────────────

  private async openSocket() {
    if (this.ws || !this.url) return;
    this.setStatus("connecting");

    let token: string | null = null;
    try {
      token = (await this.options.getToken?.()) ?? null;
    } catch {
      // Can't reach the token endpoint: almost certainly offline.
      this.scheduleReconnect();
      return;
    }
    if (!this.shouldConnect || this.ws) return;

    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${this.url}/${this.roomName}${query}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.setStatus("connected");
      this.emit("status", { status: "connected" });

      // Step 1: our state vector. The reply carries only what we lack.
      const sync = encoding.createEncoder();
      encoding.writeVarUint(sync, MSG_SYNC);
      syncProtocol.writeSyncStep1(sync, this.doc);
      this.send(sync);

      const query = encoding.createEncoder();
      encoding.writeVarUint(query, MSG_QUERY_AWARENESS);
      this.send(query);

      if (this.awareness.getLocalState() !== null) {
        this.sendAwareness([this.doc.clientID]);
      }

      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
      const type = decoding.readVarUint(decoder);
      switch (type) {
        case MSG_SYNC:
          this.handleSyncMessage(decoder);
          break;
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            this
          );
          break;
        case MSG_PING:
          break; // the timestamp above is all a pong is for
      }
    };

    ws.onclose = (event) => this.handleClose(ws, event.code);
    // An error is always followed by close; nothing to do here.
    ws.onerror = () => {};
  }

  private handleClose(ws: WebSocket, code: number) {
    if (this.ws !== ws) return; // a socket we already dropped
    this.ws = null;
    this.stopHeartbeat();
    this.setSynced(false);
    this.clearRemoteAwareness();
    this.emit("status", { status: "disconnected" });

    if (!this.shouldConnect) return;

    if (code === CLOSE_INVALID_ROOM) {
      this.setStatus("error");
      return;
    }
    if (code === CLOSE_UNAUTHORISED) {
      // Tokens expire; one fresh attempt, then give up.
      this.authFailures++;
      if (this.authFailures >= 2) {
        this.setStatus("error");
        return;
      }
    } else {
      this.authFailures = 0;
    }
    this.scheduleReconnect();
  }

  private closeSocket() {
    const ws = this.ws;
    if (!ws) return;
    // Treat it as closed now: a dead TCP connection can take a long time to
    // deliver its close event, and we don't want to wait for it.
    this.handleClose(ws, 1000);
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
  }

  // ── Reconnection ────────────────────────────────────────────────────

  /**
   * Capped exponential backoff with jitter: about 0.5s, 1s, 2s ... 30s.
   * It never gives up, because a local-first document is always worth
   * syncing eventually. Jitter spreads out clients that dropped together.
   */
  private scheduleReconnect() {
    if (!this.shouldConnect || this.reconnectTimer) return;
    this.setStatus("offline");
    const base = Math.min(
      (this.options.initialBackoff ?? 500) * 2 ** this.reconnectAttempts,
      this.options.maxBackoff ?? 30_000
    );
    const delay = base * (0.5 + Math.random() * 0.5);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private handleOnline = () => {
    if (!this.shouldConnect || this.ws || this.status === "error") return;
    this.clearReconnect();
    this.reconnectAttempts = 0;
    this.openSocket();
  };

  private handleOffline = () => {
    if (!this.ws) return;
    this.closeSocket();
    this.scheduleReconnect();
  };

  // ── Heartbeat ───────────────────────────────────────────────────────

  /**
   * A socket can look open long after the network has gone (sleep, Wi-Fi
   * switch, a proxy dropping it). Ping regularly; if nothing at all has
   * arrived for 2.5 intervals, drop the socket and reconnect.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    const interval = this.options.heartbeatInterval ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > interval * 2.5) {
        this.closeSocket();
        this.scheduleReconnect();
        return;
      }
      const ping = encoding.createEncoder();
      encoding.writeVarUint(ping, MSG_PING);
      this.send(ping);
    }, interval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ── Sync and awareness ──────────────────────────────────────────────

  private handleSyncMessage(decoder: decoding.Decoder) {
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MSG_SYNC);
    // Applies remote changes with `this` as the transaction origin, and
    // writes our step 2 into `reply` if this was the server's step 1.
    const type = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
    if (type === syncProtocol.messageYjsSyncStep2) {
      this.setSynced(true);
      this.setStatus("synced");
    }
    if (encoding.length(reply) > 1) this.send(reply);
  }

  /** Local edits go straight out; remote ones (origin === this) do not echo. */
  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.ws?.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoder);
  };

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === this) return;
    this.sendAwareness([...added, ...updated, ...removed]);
  };

  private sendAwareness(clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients)
    );
    this.send(encoder);
  }

  /** When we lose the server we can no longer vouch for anyone's cursor. */
  private clearRemoteAwareness() {
    const remote = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.doc.clientID
    );
    if (remote.length) {
      awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
    }
  }

  private send(encoder: encoding.Encoder) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encoding.toUint8Array(encoder));
    }
  }

  // ── State and events ────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((fn) => fn(status));
  }

  private setSynced(synced: boolean) {
    if (this.synced === synced) return;
    this.synced = synced;
    this.emit("sync", synced);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  isSynced(): boolean {
    return this.synced;
  }

  hasServer(): boolean {
    return this.url !== null;
  }

  onStatus(fn: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Lexical's Provider interface. */
  on(type: EventType, cb: EventCallback): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  off(type: EventType, cb: EventCallback): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(type: EventType, ...args: unknown[]): void {
    this.listeners.get(type)?.forEach((cb) => cb(...args));
  }
}
