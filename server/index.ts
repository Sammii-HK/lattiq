/**
 * Lattiq Collaboration Server — WebSocket relay for real-time Yjs sync.
 *
 * ## What this server does
 *
 * It acts as a relay and persistence layer for Yjs documents:
 *
 * 1. **Room management**: Each document gets its own "room". When a client
 *    connects to /room-name, the server creates or retrieves a room.
 *
 * 2. **Sync relay**: When Client A edits, the server receives the Yjs update
 *    and broadcasts it to Clients B, C, D... in the same room. The server
 *    also maintains its own Y.Doc mirror so new clients can sync from it.
 *
 * 3. **Persistence**: The server periodically saves the Y.Doc state to disk.
 *    When a room is created, it loads any previously saved state. This means
 *    document content survives server restarts.
 *
 * 4. **Awareness relay**: Broadcasts cursor positions and user presence to
 *    all clients in a room.
 *
 * ## Why a server-side Y.Doc mirror?
 *
 * Without it, if Client A goes offline and Client B joins, Client B would
 * have no way to get Client A's edits. The server mirror acts as a persistent
 * participant that always has the latest state.
 *
 * ## Architecture
 *
 * This is a standalone Node.js server (not part of Next.js) because:
 *   - Next.js API routes are stateless and serverless-friendly, which is
 *     fundamentally incompatible with long-lived WebSocket connections
 *   - WebSocket connections need persistent in-memory state (the rooms)
 *   - The server needs to outlive individual HTTP request lifecycles
 *
 * In production, you'd run this alongside your Next.js app, either as a
 * separate process or via a custom Next.js server.
 */

import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { IncomingMessage } from "http";
import * as fs from "fs";
import * as path from "path";

// ── Message type constants ──────────────────────────────────────────
// Must match the client's constants exactly.
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

// ── Room type ───────────────────────────────────────────────────────

/**
 * A Room represents a single collaborative document session.
 *
 * Each room has:
 *   - A Y.Doc mirror that accumulates all edits from all clients
 *   - An Awareness instance tracking cursor positions
 *   - A set of connected WebSocket clients
 *   - Bookkeeping for persistence and cleanup
 */
interface Room {
  /** Room name (usually the document ID) */
  name: string;
  /** Server-side mirror of the document — source of truth for new clients */
  doc: Y.Doc;
  /** Tracks all connected users' cursor positions and presence */
  awareness: awarenessProtocol.Awareness;
  /** All WebSocket connections currently in this room */
  clients: Map<WebSocket, { clientID: number }>;
  /** Timestamp of last activity — used for idle room cleanup */
  lastActivity: number;
  /** Debounce timer for persistence writes */
  persistTimer: ReturnType<typeof setTimeout> | null;
}

// ── Persistence directory ───────────────────────────────────────────
// We store Yjs document state as binary files on disk. In production,
// you'd use PostgreSQL or S3 — but files work great for development
// and keep this project dependency-free.
const DATA_DIR = path.join(process.cwd(), ".lattiq-data");

/** Ensure the data directory exists on startup. */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load a previously saved document from disk.
 *
 * Returns null if no saved state exists (new document).
 * The saved state is a binary Yjs update that can be applied to a
 * fresh Y.Doc to restore it to its last known state.
 */
function loadDocument(roomName: string): Uint8Array | null {
  const filePath = path.join(DATA_DIR, `${roomName}.yjs`);
  if (fs.existsSync(filePath)) {
    return new Uint8Array(fs.readFileSync(filePath));
  }
  return null;
}

/**
 * Save a document to disk.
 *
 * We write the full encoded state (Y.encodeStateAsUpdate), not individual
 * updates. This acts as a snapshot — loading it gives you the complete
 * document without needing to replay history.
 */
function saveDocument(roomName: string, state: Uint8Array) {
  const filePath = path.join(DATA_DIR, `${roomName}.yjs`);
  fs.writeFileSync(filePath, state);
}

// ── Collaboration Server ────────────────────────────────────────────

class CollaborationServer {
  /** Map of room name to Room instance */
  private rooms = new Map<string, Room>();
  private wss: WebSocketServer;

  /**
   * How long a room can be idle (no connected clients, no activity)
   * before we destroy it to free memory. Set to 5 minutes.
   */
  private IDLE_TIMEOUT = 5 * 60 * 1000;

  /**
   * How long to wait after the last edit before persisting to disk.
   *
   * We don't want to write to disk on every single keystroke — that
   * would be wasteful I/O. Instead, we debounce: wait 2 seconds after
   * the last edit, then save. If another edit comes in during the wait,
   * the timer resets.
   *
   * This means we save at most once every 2 seconds, and we always
   * capture the latest state.
   */
  private PERSIST_DEBOUNCE = 2000;

  constructor(port: number) {
    ensureDataDir();

    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", this.handleConnection);

    // Periodically clean up rooms that have no connected clients.
    // This prevents memory leaks from abandoned rooms.
    setInterval(() => this.cleanupIdleRooms(), 60_000);

    console.log(`Lattiq collaboration server running on ws://localhost:${port}`);
  }

  // ── Connection handling ─────────────────────────────────────────

  /**
   * Handle a new WebSocket connection.
   *
   * The connection flow:
   *
   * 1. Parse the room name from the URL path (e.g. /doc-getting-started)
   * 2. Get or create the room (loading from disk if it exists)
   * 3. Add the client to the room
   * 4. Send the client the full document state (sync step 1 + 2)
   * 5. Send the client all current awareness states (other users' cursors)
   * 6. Start listening for messages from this client
   *
   * This is the server-side counterpart to the client's connect() method.
   */
  private handleConnection = (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    // The room name is the URL path without the leading slash.
    // e.g. ws://localhost:3001/doc-getting-started → "doc-getting-started"
    const roomName = url.pathname.slice(1);

    // Future: authenticate the connection using the token query param.
    // const token = url.searchParams.get("token");
    // const user = await authenticate(token);
    // if (!user) { ws.close(4401, 'Unauthorized'); return; }

    const room = this.getOrCreateRoom(roomName);
    // We don't know the client's Yjs clientID yet — it will be sent
    // with their first awareness update. Store 0 as placeholder.
    room.clients.set(ws, { clientID: 0 });
    room.lastActivity = Date.now();

    // ── Send sync step 1: our state vector ────────────────────
    // Tell the client "here's what I (the server) have". The client
    // will compare this against its local doc and send back anything
    // the server is missing.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    ws.send(encoding.toUint8Array(encoder));

    // ── Send sync step 2: the full document diff ──────────────
    // Also send our full state. This ensures the client gets everything
    // even if it's connecting for the first time with an empty doc.
    // Belt and suspenders — the client might already have some state
    // from IndexedDB, and CRDTs handle the merge gracefully.
    const encoder2 = encoding.createEncoder();
    encoding.writeVarUint(encoder2, MSG_SYNC);
    syncProtocol.writeSyncStep2(encoder2, room.doc);
    ws.send(encoding.toUint8Array(encoder2));

    // ── Send current awareness states ─────────────────────────
    // Send all currently connected users' cursor positions and info
    // so the new client can render them immediately.
    const awarenessStates = room.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(awarenessStates.keys())
      );
      const aEncoder = encoding.createEncoder();
      encoding.writeVarUint(aEncoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(aEncoder, awarenessUpdate);
      ws.send(encoding.toUint8Array(aEncoder));
    }

    // ── Handle incoming messages from this client ─────────────
    ws.on("message", (data: Buffer) => {
      const message = new Uint8Array(data);

      // Single byte = heartbeat ping. Respond with pong.
      if (message.length === 1) {
        ws.send(new Uint8Array([1])); // pong
        return;
      }

      const decoder = decoding.createDecoder(message);
      const msgType = decoding.readVarUint(decoder);

      switch (msgType) {
        case MSG_SYNC:
          this.handleSync(decoder, room, ws);
          break;
        case MSG_AWARENESS:
          this.handleAwareness(decoder, room, ws);
          break;
        case MSG_QUERY_AWARENESS:
          this.handleQueryAwareness(room, ws);
          break;
      }

      room.lastActivity = Date.now();
    });

    // ── Handle client disconnect ──────────────────────────────
    ws.on("close", () => {
      const clientMeta = room.clients.get(ws);
      room.clients.delete(ws);

      // Remove this client's awareness state so other users see them
      // disappear. We use the clientID we captured from their awareness
      // updates.
      if (clientMeta && clientMeta.clientID > 0) {
        awarenessProtocol.removeAwarenessStates(
          room.awareness,
          [clientMeta.clientID],
          null
        );

        // Broadcast the removal to remaining clients.
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
          room.awareness,
          [clientMeta.clientID]
        );
        this.broadcastAwareness(room, awarenessUpdate, ws);
      }
    });
  };

  // ── Sync message handling ─────────────────────────────────────

  /**
   * Handle an incoming sync message from a client.
   *
   * readSyncMessage does the heavy lifting:
   *   - If it's SyncStep1 from the client, it writes our SyncStep2 reply
   *   - If it's SyncStep2, it applies the client's state to our doc
   *   - If it's an Update, it applies the incremental change to our doc
   *
   * After applying an update, the Y.Doc 'update' event fires, which
   * triggers broadcastUpdate to relay the change to other clients.
   */
  private handleSync(
    decoder: decoding.Decoder,
    room: Room,
    sender: WebSocket
  ) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);

    // readSyncMessage reads the incoming message, applies updates to
    // room.doc, and writes any necessary response into the encoder.
    // The 'sender' argument is passed as the transaction origin so
    // we can filter it out in the broadcast handler.
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, sender);

    // If the encoder has content beyond the message type byte,
    // send the response back to the sender (e.g. SyncStep2 reply).
    if (encoding.length(encoder) > 1) {
      sender.send(encoding.toUint8Array(encoder));
    }
  }

  // ── Awareness message handling ────────────────────────────────

  /**
   * Handle an incoming awareness message from a client.
   *
   * Awareness messages contain cursor positions, user names, colours,
   * and other ephemeral per-user state. We:
   *
   * 1. Apply the update to our server-side Awareness instance (so we
   *    have an accurate picture of who's connected)
   * 2. Extract the sender's clientID and store it (needed for cleanup
   *    when they disconnect)
   * 3. Broadcast the update to all OTHER clients in the room
   */
  private handleAwareness(
    decoder: decoding.Decoder,
    room: Room,
    sender: WebSocket
  ) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, sender);

    // Extract the sender's Yjs clientID from the awareness update.
    // We need this to clean up their awareness state when they disconnect.
    // The awareness update is encoded as: [length, clientID, clock, state...]
    // We decode just the clientID from the first entry.
    try {
      const updateDecoder = decoding.createDecoder(update);
      const count = decoding.readVarUint(updateDecoder);
      if (count > 0) {
        const clientID = decoding.readVarUint(updateDecoder);
        const clientMeta = room.clients.get(sender);
        if (clientMeta) {
          clientMeta.clientID = clientID;
        }
      }
    } catch {
      // If we can't parse the clientID, that's ok — we just won't be
      // able to clean up this client's awareness on disconnect.
    }

    // Broadcast to all other clients in the room.
    this.broadcastAwareness(room, update, sender);
  }

  /**
   * Handle a query for all current awareness states.
   *
   * A client sends this when it first connects and wants to know
   * about all other users currently in the room. We respond with
   * the full awareness state.
   */
  private handleQueryAwareness(room: Room, sender: WebSocket) {
    const states = room.awareness.getStates();
    if (states.size === 0) return;

    const update = awarenessProtocol.encodeAwarenessUpdate(
      room.awareness,
      Array.from(states.keys())
    );
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    sender.send(encoding.toUint8Array(encoder));
  }

  /**
   * Broadcast an awareness update to all clients in a room except the sender.
   */
  private broadcastAwareness(
    room: Room,
    update: Uint8Array,
    sender: WebSocket
  ) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const message = encoding.toUint8Array(encoder);

    room.clients.forEach((_, client) => {
      if (client !== sender && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // ── Room management ───────────────────────────────────────────

  /**
   * Get an existing room or create a new one.
   *
   * When creating a new room:
   * 1. Create a fresh Y.Doc
   * 2. Load any previously saved state from disk
   * 3. Set up listeners to broadcast updates and persist changes
   *
   * The room's Y.Doc acts as a "server peer" — it participates in the
   * CRDT just like any client. This means the server always has the
   * complete, merged document state.
   */
  private getOrCreateRoom(name: string): Room {
    const existing = this.rooms.get(name);
    if (existing) return existing;

    const doc = new Y.Doc();

    // Load previously saved state from disk.
    const savedState = loadDocument(name);
    if (savedState) {
      Y.applyUpdate(doc, savedState);
    }

    // When the Y.Doc changes (from any client's sync message),
    // broadcast the update to all other clients and schedule a persist.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const room = this.rooms.get(name);
      if (!room) return;

      // Broadcast to all clients except the one that sent the update.
      // The 'origin' is the WebSocket that sent the message (set in
      // handleSync via readSyncMessage's last argument).
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      room.clients.forEach((_, client) => {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });

      // Schedule a debounced persist to disk.
      this.schedulePersist(name);
    });

    const awareness = new awarenessProtocol.Awareness(doc);

    const room: Room = {
      name,
      doc,
      awareness,
      clients: new Map(),
      lastActivity: Date.now(),
      persistTimer: null,
    };

    this.rooms.set(name, room);
    return room;
  }

  // ── Persistence ───────────────────────────────────────────────

  /**
   * Schedule a debounced persist of a room's document to disk.
   *
   * ## Why debounce?
   *
   * Every keystroke generates a Yjs update. Writing to disk on every
   * keystroke would be wasteful — the OS would be constantly flushing
   * tiny writes. Instead, we wait 2 seconds after the last edit.
   * If more edits come in during the wait, the timer resets.
   *
   * This means:
   *   - During active typing: no disk writes (timer keeps resetting)
   *   - 2 seconds after the user stops: one write with everything
   *   - Worst case data loss on crash: last 2 seconds of edits
   *     (but the client's IndexedDB still has them — local-first!)
   */
  private schedulePersist(roomName: string) {
    const room = this.rooms.get(roomName);
    if (!room) return;

    if (room.persistTimer) clearTimeout(room.persistTimer);

    room.persistTimer = setTimeout(() => {
      const state = Y.encodeStateAsUpdate(room.doc);
      saveDocument(roomName, state);
    }, this.PERSIST_DEBOUNCE);
  }

  // ── Idle room cleanup ─────────────────────────────────────────

  /**
   * Destroy rooms that have no clients and haven't been active recently.
   *
   * ## Why bother?
   *
   * Each room holds a Y.Doc in memory. For a document with lots of edit
   * history, this can be significant (MBs). If nobody is connected and
   * nobody has been for 5 minutes, we:
   *
   * 1. Save the final state to disk (so nothing is lost)
   * 2. Destroy the Y.Doc to free memory
   * 3. Remove the room from our Map
   *
   * When someone reconnects, getOrCreateRoom() will reload from disk.
   */
  private cleanupIdleRooms() {
    const now = Date.now();

    this.rooms.forEach((room, name) => {
      if (
        room.clients.size === 0 &&
        now - room.lastActivity > this.IDLE_TIMEOUT
      ) {
        // Persist final state before cleanup.
        const state = Y.encodeStateAsUpdate(room.doc);
        saveDocument(name, state);

        // Clean up.
        room.doc.destroy();
        room.awareness.destroy();
        if (room.persistTimer) clearTimeout(room.persistTimer);
        this.rooms.delete(name);
        console.log(`Cleaned up idle room: ${name}`);
      }
    });
  }
}

// ── Start the server ────────────────────────────────────────────────
const PORT = parseInt(process.env.WS_PORT ?? "3001", 10);
new CollaborationServer(PORT);
