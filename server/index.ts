/**
 * Lattiq room server: a WebSocket relay and persistence layer for Yjs.
 *
 * Each document is a room. The server keeps a Y.Doc per active room so a
 * newcomer can sync from it even when nobody else is online, relays updates
 * and awareness (cursors, names) between clients, and writes each room to
 * disk a couple of seconds after it changes.
 *
 * It is a separate process because Next.js route handlers (and Vercel
 * functions) are request-scoped and can't hold long-lived sockets or the
 * in-memory rooms.
 *
 * ## Protocol (first VarUint of every frame; matches the client)
 *
 *   0 sync, 1 awareness, 3 query awareness, 4 ping (echoed)
 *
 * On connect the server sends only its sync step 1 (its state vector). The
 * client answers with step 2 (what the server lacks) and sends its own
 * step 1, which the server answers with only what the client lacks. So a
 * client that already has the seed, or an older copy from IndexedDB,
 * downloads just the difference, not the whole book.
 *
 * ## Access control
 *
 *   - Room names must match /^doc-[a-z0-9-]+$/ (they become file names).
 *   - With LATTIQ_ROOM_SECRET set, a connection must carry ?token= signed
 *     for that exact room by the Next.js app (see src/lib/room-token.ts).
 *     Without it, the server is open: fine for localhost, logged loudly.
 *   - With ALLOWED_ORIGINS set, browser connections from other origins are
 *     refused before the upgrade.
 *
 * ## Environment
 *
 *   PORT (or WS_PORT)      default 3001
 *   LATTIQ_ROOM_SECRET     shared with the Next.js app; enables token checks
 *   ALLOWED_ORIGINS        comma-separated, e.g. https://lattiq.sammii.dev
 *   LATTIQ_DATA_DIR        where rooms are persisted (default ./.lattiq-data)
 *   LATTIQ_SEED_DIR        seed files for new rooms (default ./public/seed)
 */

import http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as fs from "fs";
import * as path from "path";
import { ROOM_NAME_PATTERN, verifyRoomToken } from "../src/lib/room-token";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const MSG_PING = 4;

const CLOSE_INVALID_ROOM = 4400;
const CLOSE_UNAUTHORISED = 4401;
const CLOSE_ROOM_FULL = 4429;

const PORT = parseInt(process.env.PORT ?? process.env.WS_PORT ?? "3001", 10);
const SECRET = process.env.LATTIQ_ROOM_SECRET || null;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const DATA_DIR = path.resolve(process.env.LATTIQ_DATA_DIR ?? ".lattiq-data");
const SEED_DIR = path.resolve(process.env.LATTIQ_SEED_DIR ?? "public/seed");

const PERSIST_DEBOUNCE_MS = 2000;
const IDLE_ROOM_MS = 5 * 60 * 1000;
const MAX_CLIENTS_PER_ROOM = 50;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024; // a full book's first sync is ~1.3 MB

// ── Persistence ───────────────────────────────────────────────────────

function roomFile(room: string) {
  return path.join(DATA_DIR, `${room}.yjs`);
}

/** Saved state if the room has been used before, else the document's seed. */
function loadRoomState(room: string): Uint8Array | null {
  for (const file of [roomFile(room), path.join(SEED_DIR, `${room.slice(4)}.yjs`)]) {
    if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
  }
  return null;
}

/** Write to a temp file then rename, so a crash mid-write can't corrupt a room. */
function saveRoomState(room: string, state: Uint8Array) {
  const file = roomFile(room);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, state);
  fs.renameSync(tmp, file);
}

// ── Rooms ─────────────────────────────────────────────────────────────

interface Room {
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Each socket and the awareness client IDs it controls. */
  conns: Map<WebSocket, Set<number>>;
  lastActivity: number;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();

function send(ws: WebSocket, message: Uint8Array) {
  if (ws.readyState === WebSocket.OPEN) ws.send(message);
}

function broadcast(room: Room, message: Uint8Array, except: unknown) {
  room.conns.forEach((_, ws) => {
    if (ws !== except) send(ws, message);
  });
}

function persistNow(room: Room) {
  if (room.persistTimer) clearTimeout(room.persistTimer);
  room.persistTimer = null;
  saveRoomState(room.name, Y.encodeStateAsUpdate(room.doc));
}

function getRoom(name: string): Room {
  const existing = rooms.get(name);
  if (existing) return existing;

  const doc = new Y.Doc();
  const saved = loadRoomState(name);
  if (saved) Y.applyUpdate(doc, saved);

  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server isn't a participant

  const room: Room = {
    name,
    doc,
    awareness,
    conns: new Map(),
    lastActivity: Date.now(),
    persistTimer: null,
  };

  // Relay every change to everyone except the client it came from.
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder), origin);

    if (room.persistTimer) clearTimeout(room.persistTimer);
    room.persistTimer = setTimeout(() => persistNow(room), PERSIST_DEBOUNCE_MS);
  });

  // Track which awareness IDs each socket owns (so we can remove them when
  // it drops) and relay awareness changes.
  awareness.on(
    "update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      const owned = origin instanceof WebSocket ? room.conns.get(origin) : undefined;
      if (owned) {
        // A client that clears its state and sets it again (Lexical does on
        // page hide, then blur) comes back as "updated", not "added", so
        // both count as owned.
        added.forEach((id) => owned.add(id));
        updated.forEach((id) => owned.add(id));
        removed.forEach((id) => owned.delete(id));
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
      );
      broadcast(room, encoding.toUint8Array(encoder), origin);
    }
  );

  rooms.set(name, room);
  return room;
}

// ── Connections ───────────────────────────────────────────────────────

function onMessage(room: Room, ws: WebSocket, data: Uint8Array) {
  room.lastActivity = Date.now();
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);

  switch (type) {
    case MSG_SYNC: {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, reply, room.doc, ws);
      if (encoding.length(reply) > 1) send(ws, encoding.toUint8Array(reply));
      break;
    }
    case MSG_AWARENESS:
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
      break;
    case MSG_QUERY_AWARENESS: {
      const ids = [...room.awareness.getStates().keys()];
      if (ids.length === 0) break;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids));
      send(ws, encoding.toUint8Array(encoder));
      break;
    }
    case MSG_PING: {
      const pong = encoding.createEncoder();
      encoding.writeVarUint(pong, MSG_PING);
      send(ws, encoding.toUint8Array(pong));
      break;
    }
  }
}

function onConnection(ws: WebSocket, roomName: string) {
  const room = getRoom(roomName);
  if (room.conns.size >= MAX_CLIENTS_PER_ROOM) {
    ws.close(CLOSE_ROOM_FULL, "Room full");
    return;
  }
  room.conns.set(ws, new Set());
  room.lastActivity = Date.now();

  // Liveness: ws-level pings catch sockets that died without a close frame.
  let alive = true;
  ws.on("pong", () => (alive = true));
  const pinger = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on("message", (raw: RawData) => {
    try {
      const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as Buffer);
      onMessage(room, ws, data);
    } catch (err) {
      console.warn(`[${roomName}] bad message, closing:`, (err as Error).message);
      ws.close(1003, "Bad message");
    }
  });

  ws.on("close", () => {
    clearInterval(pinger);
    const owned = room.conns.get(ws);
    room.conns.delete(ws);
    room.lastActivity = Date.now();
    if (owned?.size) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null);
    }
  });

  // Our state vector; the client replies with whatever we're missing.
  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MSG_SYNC);
  syncProtocol.writeSyncStep1(step1, room.doc);
  send(ws, encoding.toUint8Array(step1));
}

// ── HTTP + upgrade ────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const roomName = url.pathname.slice(1);

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Rejections happen after the upgrade so the browser sees a close code
    // it can act on (a failed handshake only ever reports 1006).
    if (!ROOM_NAME_PATTERN.test(roomName)) {
      ws.close(CLOSE_INVALID_ROOM, "Invalid room");
      return;
    }
    if (SECRET && !verifyRoomToken(SECRET, roomName, url.searchParams.get("token"))) {
      ws.close(CLOSE_UNAUTHORISED, "Unauthorised");
      return;
    }
    onConnection(ws, roomName);
  });
});

// ── Housekeeping ──────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, name) => {
    if (room.conns.size === 0 && now - room.lastActivity > IDLE_ROOM_MS) {
      persistNow(room);
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(name);
    }
  });
}, 60_000).unref();

function shutdown(signal: string) {
  console.log(`${signal}: saving ${rooms.size} room(s)`);
  rooms.forEach((room) => {
    if (room.persistTimer) persistNow(room);
  });
  wss.clients.forEach((ws) => ws.close(1001, "Server restarting"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

fs.mkdirSync(DATA_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`Lattiq room server on ws://localhost:${PORT}`);
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  seeds: ${SEED_DIR}`);
  if (!SECRET) console.warn("  LATTIQ_ROOM_SECRET not set: any client can open any valid room");
  if (ALLOWED_ORIGINS.length) console.log(`  origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
