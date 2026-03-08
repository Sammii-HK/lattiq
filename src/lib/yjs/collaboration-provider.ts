/**
 * CollaborationProvider — Custom WebSocket provider for Yjs.
 *
 * ## Why build a custom provider instead of using y-websocket?
 *
 * The default y-websocket provider works, but building our own gives us:
 * 1. Full control over the connection lifecycle (reconnection, auth, heartbeat)
 * 2. Update buffering while offline (local-first: edits are never lost)
 * 3. A proper event system for the UI to react to connection state changes
 * 4. Understanding of the Yjs sync protocol at a low level
 *
 * ## How the Yjs sync protocol works
 *
 * Yjs uses a 2-step sync handshake, similar to how Git negotiates a push:
 *
 *   Step 1: "Here's what I have" (state vector)
 *     - Client sends its state vector to the server
 *     - A state vector is a compact summary: { clientA: clock5, clientB: clock3 }
 *     - It tells the server which operations the client has already seen
 *
 *   Step 2: "Here's what you're missing" (diff)
 *     - Server compares the client's state vector against its own document
 *     - Sends back only the operations the client is missing
 *     - Client applies them to its local Y.Doc — CRDTs guarantee convergence
 *
 * After the handshake, both sides stream incremental updates in real time.
 *
 * ## Message types on the wire
 *
 * Every WebSocket message starts with a variable-length unsigned integer
 * (VarUint) that identifies the message type:
 *
 *   0 = MSG_SYNC       — Yjs sync protocol messages (step1, step2, update)
 *   1 = MSG_AWARENESS   — Presence data (cursor positions, user info)
 *   2 = MSG_AUTH         — Authentication response from server
 *   3 = MSG_QUERY_AWARENESS — Request all current awareness states
 *
 * All data is binary (Uint8Array), encoded with lib0's efficient binary format.
 * This is much more compact than JSON — a typical keystroke update is ~20 bytes.
 *
 * ## The Provider interface
 *
 * Lexical's CollaborationPlugin expects a Provider with:
 *   - connect() / disconnect()
 *   - on(event, cb) / off(event, cb) for 'sync', 'status'
 *   - awareness: an Awareness instance
 *
 * This class satisfies that interface while adding reconnection, heartbeat,
 * and offline buffering on top.
 */

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// ── Message type constants ──────────────────────────────────────────
// These must match the server's constants exactly. They're the first
// byte of every WebSocket message and tell the receiver how to decode
// the rest of the payload.
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;
const MSG_QUERY_AWARENESS = 3;

/**
 * Connection status state machine:
 *
 *   disconnected ──► connecting ──► connected
 *        ▲                              │
 *        │                              ▼
 *        └────── reconnecting ◄──── (ws closes)
 *
 * The UI uses these states to show appropriate indicators:
 *   - connecting: initial connection attempt
 *   - connected: WebSocket is open and synced
 *   - reconnecting: lost connection, trying to get it back
 *   - disconnected: gave up or intentionally disconnected
 */
type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

interface ProviderOptions {
  /** Pre-existing Awareness instance (created if not provided) */
  awareness?: awarenessProtocol.Awareness;
  /** Auth token sent as query param on connection */
  token?: string;
  /** How many times to retry before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /** Initial delay before first retry in ms (default: 500) */
  initialBackoff?: number;
  /** Maximum delay between retries in ms (default: 30000) */
  maxBackoff?: number;
  /** How often to check if the connection is alive in ms (default: 15000) */
  heartbeatInterval?: number;
}

// Event types that CollaborationPlugin subscribes to.
// 'sync' fires when the initial sync handshake completes.
// 'status' fires on every connection state change.
// 'update' and 'reload' are used by Lexical internally.
type EventType = "sync" | "status" | "update" | "reload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventCallback = (...args: any[]) => void;

export class CollaborationProvider {
  /** The Yjs document this provider syncs */
  doc: Y.Doc;

  /**
   * Awareness tracks ephemeral, per-user state that doesn't persist:
   *   - Cursor position and selection range
   *   - User name and colour
   *   - "Is typing" indicator
   *
   * Unlike the Y.Doc (which uses CRDTs and persists), awareness state
   * is volatile — it's lost when the user disconnects. This is intentional:
   * you don't want someone's cursor from last Tuesday still showing up.
   *
   * Awareness uses a simple last-write-wins model (not CRDTs) because
   * cursor positions don't need conflict resolution — each user owns
   * their own cursor state exclusively.
   */
  awareness: awarenessProtocol.Awareness;

  private ws: WebSocket | null = null;
  private url: string;
  private roomName: string;
  private token: string | undefined;

  // ── Reconnection state ────────────────────────────────────────
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private initialBackoff: number;
  private maxBackoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Heartbeat ─────────────────────────────────────────────────
  // WebSocket connections can silently die (e.g. laptop sleep, network
  // switch). The heartbeat detects this by sending periodic pings.
  // If we don't get a pong within 2x the interval, we assume the
  // connection is dead and force a reconnect.
  private heartbeatInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;

  // ── Sync state ────────────────────────────────────────────────
  // Tracks whether the initial 2-step sync handshake has completed.
  // Until synced=true, the client might be missing remote changes.
  private synced = false;

  // ── Event listeners ───────────────────────────────────────────
  // Simple event emitter for UI components to subscribe to state changes.
  // We use Sets so the same callback can't be registered twice.
  private listeners: Map<EventType, Set<EventCallback>> = new Map();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private syncListeners = new Set<(synced: boolean) => void>();

  // ── Offline buffer ────────────────────────────────────────────
  // This is the key to local-first: when the WebSocket is down,
  // edits are buffered here. On reconnect, they're merged into a
  // single update and sent to the server. No edits are ever lost.
  private pendingUpdates: Uint8Array[] = [];

  constructor(
    url: string,
    roomName: string,
    doc: Y.Doc,
    options: ProviderOptions = {}
  ) {
    this.url = url;
    this.roomName = roomName;
    this.doc = doc;
    this.token = options.token;
    this.awareness =
      options.awareness ?? new awarenessProtocol.Awareness(doc);
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.initialBackoff = options.initialBackoff ?? 500;
    this.maxBackoff = options.maxBackoff ?? 30000;
    this.heartbeatInterval = options.heartbeatInterval ?? 15000;

    // Listen for local document updates — when the user types, we need
    // to send the resulting Yjs update to the server for other clients.
    this.doc.on("update", this.handleDocUpdate);

    // Listen for awareness changes — when the user moves their cursor,
    // we broadcast the new position to other clients.
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  // ══════════════════════════════════════════════════════════════
  // Connection lifecycle
  // ══════════════════════════════════════════════════════════════

  /**
   * Open a WebSocket connection to the collaboration server.
   *
   * The URL format is: ws://host:port/room-name?token=xxx
   * Each document gets its own "room" on the server. The server
   * maintains a Y.Doc mirror per room and relays updates between
   * all connected clients.
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setStatus("connecting");

    const wsUrl = `${this.url}/${this.roomName}${
      this.token ? `?token=${this.token}` : ""
    }`;
    this.ws = new WebSocket(wsUrl);

    // Binary mode: Yjs updates are Uint8Arrays, not strings.
    // Using arraybuffer avoids the overhead of Blob conversion.
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.setStatus("connected");
      this.reconnectAttempts = 0;
      this.synced = false;

      // ── Sync step 1: send our state vector ──────────────────
      // This tells the server "here's what I already have".
      // The server will respond with step 2: "here's what you're missing".
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoder);

      // ── Request awareness states ────────────────────────────
      // Ask the server to send us all other users' cursor positions
      // and presence info so we can render them immediately.
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MSG_QUERY_AWARENESS);
      this.send(awarenessEncoder);

      // ── Broadcast our own awareness ─────────────────────────
      // Tell other users about our cursor position and user info.
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        [this.doc.clientID]
      );
      const aEncoder = encoding.createEncoder();
      encoding.writeVarUint(aEncoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(aEncoder, awarenessUpdate);
      this.send(aEncoder);

      // ── Flush offline buffer ────────────────────────────────
      // Send any edits that happened while we were disconnected.
      this.flushPendingUpdates();

      // ── Start heartbeat ─────────────────────────────────────
      this.startHeartbeat();

      // Emit events for CollaborationPlugin
      this.emit("status", { status: "connected" });
    };

    this.ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      const decoder = decoding.createDecoder(data);
      const msgType = decoding.readVarUint(decoder);

      switch (msgType) {
        case MSG_SYNC:
          this.handleSyncMessage(decoder);
          break;
        case MSG_AWARENESS:
          this.handleAwarenessMessage(decoder);
          break;
        case MSG_AUTH:
          // Server rejected our auth token — don't reconnect,
          // the token won't magically become valid.
          console.error("CollaborationProvider: auth failed");
          this.disconnect();
          break;
      }
    };

    this.ws.onclose = (event) => {
      this.stopHeartbeat();

      // Emit disconnected status for CollaborationPlugin
      this.emit("status", { status: "disconnected" });

      if (event.code === 4401) {
        // 4401 = custom auth failure code from our server.
        // Don't reconnect — the credentials are wrong.
        this.setStatus("disconnected");
        return;
      }

      // For all other close reasons (network drop, server restart, etc.),
      // attempt to reconnect with exponential backoff.
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // WebSocket errors are always followed by a close event,
      // so we just close here and let onclose handle reconnection.
      this.ws?.close();
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Reconnection with exponential backoff + jitter
  // ══════════════════════════════════════════════════════════════

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * ## Why exponential backoff?
   *
   * If the server goes down and 100 clients try to reconnect simultaneously,
   * the server gets hammered the instant it comes back up ("thundering herd").
   * Exponential backoff spaces out retry attempts: 500ms, 1s, 2s, 4s, 8s...
   *
   * ## Why jitter?
   *
   * Even with exponential backoff, clients that disconnected at the same time
   * will retry at the same intervals. Adding random jitter (50-100% of the
   * delay) spreads the retries out so the server can handle them gradually.
   *
   * ## Why a maximum?
   *
   * Without a cap, the delay would grow forever (2^20 = 17 minutes!).
   * We cap at 30 seconds so the user doesn't wait too long between attempts.
   */
  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Give up after max attempts — the server might be down for good.
      // The user can manually refresh to try again.
      this.setStatus("disconnected");
      return;
    }

    this.setStatus("reconnecting");

    // Calculate delay: min(initialBackoff * 2^attempts, maxBackoff)
    const baseDelay = Math.min(
      this.initialBackoff * Math.pow(2, this.reconnectAttempts),
      this.maxBackoff
    );

    // Add jitter: random value between 50% and 100% of baseDelay
    const jitter = baseDelay * (0.5 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, jitter);
  }

  // ══════════════════════════════════════════════════════════════
  // Heartbeat (dead connection detection)
  // ══════════════════════════════════════════════════════════════

  /**
   * Detect silently dead WebSocket connections.
   *
   * ## The problem
   *
   * A WebSocket can appear "open" even when the underlying TCP connection
   * is dead. This happens when:
   *   - The user's laptop sleeps and wakes on a different network
   *   - A proxy or load balancer silently drops the connection
   *   - The server process crashes without sending a close frame
   *
   * The browser won't fire onclose until it tries to send data and fails,
   * which could take minutes (TCP timeout).
   *
   * ## The solution
   *
   * Send a 1-byte ping every 15 seconds. If we don't get any response
   * (awareness updates count as implicit pongs) within 30 seconds,
   * force-close the connection and trigger reconnection.
   */
  private startHeartbeat() {
    this.lastPong = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPong > this.heartbeatInterval * 2) {
        // No response for 2x the heartbeat interval — connection is dead.
        this.ws?.close();
        return;
      }

      // Send a minimal 1-byte ping. The server responds with [1] (pong).
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(new Uint8Array([0]));
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ══════════════════════════════════════════════════════════════
  // Message handlers
  // ══════════════════════════════════════════════════════════════

  /**
   * Handle an incoming sync protocol message.
   *
   * The sync protocol has 3 sub-message types (handled internally by
   * syncProtocol.readSyncMessage):
   *
   *   - SyncStep1: Server sends its state vector, asking "what do you have?"
   *     We respond with SyncStep2 containing the diff.
   *
   *   - SyncStep2: Server sends the operations we're missing.
   *     These get applied to our local Y.Doc. After receiving this,
   *     the initial sync is complete.
   *
   *   - Update: A real-time incremental update (another user typed something).
   *     Applied directly to our local Y.Doc.
   *
   * readSyncMessage returns the sub-message type so we know when sync
   * is complete (type 1 = SyncStep2 received).
   */
  private handleSyncMessage(decoder: decoding.Decoder) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);

    // readSyncMessage reads the incoming message, applies it to our doc,
    // and writes any response (e.g. our SyncStep2 reply) into the encoder.
    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      this // origin — so we can filter out our own updates
    );

    // syncMessageType 1 = we just received SyncStep2 (the server's diff).
    // This means the initial sync handshake is complete — our doc now has
    // all the server's data, and the server has all of ours.
    if (syncMessageType === 1) {
      this.setSynced(true);
    }

    // If our response encoder has content beyond the message type byte,
    // send it back. This happens when we receive SyncStep1 and need to
    // reply with SyncStep2 (our diff for the server).
    if (encoding.length(encoder) > 1) {
      this.send(encoder);
    }
  }

  /**
   * Handle an incoming awareness message.
   *
   * Awareness messages contain other users' cursor positions, selections,
   * and user info. They're applied to our local Awareness instance, which
   * triggers re-renders of cursor overlays in the editor.
   *
   * We also treat awareness messages as implicit heartbeat pongs — if we're
   * receiving awareness updates, the connection is clearly alive.
   */
  private handleAwarenessMessage(decoder: decoding.Decoder) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);

    // Any incoming message proves the connection is alive.
    this.lastPong = Date.now();
  }

  /**
   * Handle a local document update (the user typed something).
   *
   * ## The origin parameter
   *
   * When we apply a remote update (from handleSyncMessage), Yjs fires
   * the 'update' event with origin=this (the provider). We check for
   * this to avoid echoing remote updates back to the server — that would
   * create an infinite loop: server → client → server → client...
   *
   * ## Offline buffering
   *
   * If the WebSocket is down, we push updates to pendingUpdates[].
   * When the connection is restored, flushPendingUpdates() merges them
   * all into a single update and sends it. This is the heart of
   * local-first: the user never loses work, even if the server is down.
   */
  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Don't echo back updates that came from the server.
    if (origin === this) return;

    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Offline: buffer the update for later. These will be merged and
      // sent when the connection is restored.
      this.pendingUpdates.push(update);
      return;
    }

    // Online: send the update immediately.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoder);
  };

  /**
   * Handle a local awareness update (the user moved their cursor).
   *
   * Awareness updates contain three arrays:
   *   - added: new clients that just connected
   *   - updated: clients whose state changed (cursor moved, etc.)
   *   - removed: clients that disconnected
   *
   * We encode these changes and broadcast them to the server, which
   * relays them to all other clients in the same room.
   */
  private handleAwarenessUpdate = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    // Don't echo back awareness updates that came from the server.
    if (origin === this) return;

    const changedClients = [...added, ...updated, ...removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
    );
    this.send(encoder);
  };

  // ══════════════════════════════════════════════════════════════
  // Offline buffer flush
  // ══════════════════════════════════════════════════════════════

  /**
   * Send all buffered updates that accumulated while offline.
   *
   * ## Why merge before sending?
   *
   * If the user typed 500 characters while offline, we have 500 individual
   * Yjs updates. Sending them one by one would be wasteful — each would
   * need its own WebSocket frame with headers.
   *
   * Y.mergeUpdates() combines them into a single update that produces the
   * same result. This is possible because Yjs updates are commutative and
   * idempotent — the order doesn't matter, and applying the same update
   * twice is harmless.
   */
  private flushPendingUpdates() {
    if (this.pendingUpdates.length === 0) return;

    const merged = Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, merged);
    this.send(encoder);
  }

  // ══════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════

  /** Send an encoded message if the WebSocket is open. */
  private send(encoder: encoding.Encoder) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encoding.toUint8Array(encoder));
    }
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.statusListeners.forEach((fn) => fn(status));
  }

  private setSynced(synced: boolean) {
    this.synced = synced;
    this.syncListeners.forEach((fn) => fn(synced));
    this.emit("sync", synced);
  }

  // ── Event emitter (for CollaborationPlugin compatibility) ─────

  on(type: EventType, cb: EventCallback): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(cb);
  }

  off(type: EventType, cb: EventCallback): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(type: EventType, ...args: unknown[]): void {
    this.listeners.get(type)?.forEach((cb) => cb(...args));
  }

  // ══════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onStatus(fn: (status: ConnectionStatus) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Subscribe to sync state changes. Returns an unsubscribe function. */
  onSync(fn: (synced: boolean) => void) {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }

  /** Get the current connection status. */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Whether the initial sync handshake has completed. */
  isSynced(): boolean {
    return this.synced;
  }

  /**
   * Gracefully disconnect from the server.
   *
   * Before closing the WebSocket, we remove our awareness state so other
   * users see us disappear immediately (rather than waiting for the server
   * to detect the disconnect via timeout).
   */
  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();

    // Tell other users we're leaving by removing our awareness state.
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "disconnect"
    );

    this.ws?.close();
    this.setStatus("disconnected");
    this.emit("status", { status: "disconnected" });
  }

  /**
   * Permanently destroy this provider.
   *
   * Removes all event listeners from the Y.Doc and Awareness to prevent
   * memory leaks. After calling destroy(), this provider cannot be reused.
   */
  destroy() {
    this.disconnect();
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.statusListeners.clear();
    this.syncListeners.clear();
    this.listeners.clear();
  }
}
