# Real-Time Collaborative Editor — Full Architecture Guide

## Project Overview

A **local-first** real-time collaborative rich text editor built with **Lexical**, **Yjs (CRDTs)**, and **WebSockets** on **Next.js**. This project demonstrates mastery of conflict resolution, real-time data synchronization, local-first architecture, and large dataset handling — four of the most challenging problems in modern web development.

**What makes this a standout portfolio piece:** Most developers can build a CRUD app. Very few can explain CRDTs, implement a local-first sync engine, handle document partitioning for large files, and demonstrate awareness/cursor presence — all in one cohesive project. Seeded with real public domain literature (Project Gutenberg) ranging from 6K to 580K+ words to demonstrate scaling.

---

## Tech Stack

| Layer              | Technology                                               | Why                                                      |
| ------------------ | -------------------------------------------------------- | -------------------------------------------------------- |
| Framework          | Next.js (App Router)                                     | Fullstack, SSR for initial doc load                      |
| Editor             | Lexical                                                  | Meta's extensible editor framework, tree-based model     |
| CRDT Engine        | Yjs                                                      | Battle-tested CRDT lib, has `@lexical/yjs` bindings      |
| Local Persistence  | y-indexeddb + OPFS                                       | Local-first: IndexedDB for small docs, OPFS for large    |
| WebSocket Server   | Custom Node.js (via Next.js custom server or standalone) | Full control over connection lifecycle                   |
| WebSocket Provider | y-websocket (modified)                                   | Bridges Yjs ↔ WebSocket, handles encoding                |
| Database           | PostgreSQL + Redis                                       | Postgres for server backup, Redis for pub/sub & presence |
| Auth               | NextAuth.js                                              | Session-based auth for identifying collaborators         |
| State Management   | Zustand                                                  | Lightweight, perfect for editor/UI state                 |
| PWA                | Service Worker + manifest.json                           | True offline — app loads without internet                |
| Seed Data          | Project Gutenberg (Gutendex API)                         | Public domain books for realistic large document demos   |

---

## Architecture Diagram (Local-First)

```
┌──────────────────────────────────────────────────────────────────┐
│                      CLIENT (Browser)                             │
│                                                                   │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────────┐  │
│  │  Lexical  │◄──►│ @lexical/yjs │◄──►│      Y.Doc (Local)     │  │
│  │  Editor   │    │   Binding    │    │   ← SOURCE OF TRUTH    │  │
│  └──────────┘    └──────────────┘    └───────────┬────────────┘  │
│                                                   │               │
│                                          ┌────────┴────────┐     │
│                                          │                 │     │
│                                          ▼                 ▼     │
│                                ┌──────────────┐  ┌─────────────┐ │
│                                │  IndexedDB   │  │  WebSocket  │ │
│                                │  / OPFS      │  │  Provider   │ │
│                                │              │  │ (when online)│ │
│                                │  ALWAYS      │  │  OPTIONAL   │ │
│                                │  AVAILABLE   │  │  BACKGROUND │ │
│                                └──────────────┘  └──────┬──────┘ │
│                                                         │        │
│  ┌────────────────────┐                                │        │
│  │  Sync Status Manager│ ◄─────────────────────────────┤        │
│  │  (local-only /      │                                │        │
│  │   syncing / synced / │                               │        │
│  │   offline)           │                               │        │
│  └────────────────────┘                                │        │
│                                                         │        │
│  ┌────────────────────┐    ┌──────────────────┐        │        │
│  │  Service Worker     │    │ Presence Manager  │◄──────┤        │
│  │  (PWA offline)      │    │ (cursors, users)  │       │        │
│  └────────────────────┘    └──────────────────┘        │        │
└─────────────────────────────────────────────────────────┼────────┘
                                                          │
                                            WebSocket (when available)
                                      (binary Yjs updates + presence)
                                                          │
┌─────────────────────────────────────────────────────────┼────────┐
│                 SERVER (Relay + Backup)                   │        │
│                                                          │        │
│  ┌───────────────────────────────────────────────────────┘       │
│  │                                                               │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐       │
│  │  │  Room Manager│  │ Y.Doc (Server│  │  Awareness     │       │
│  │  │  (per-doc)   │  │   Mirror)    │  │  Protocol      │       │
│  │  └──────┬──────┘  └──────┬───────┘  └───────────────┘       │
│  └─────────┼────────────────┼──────────────────────────────────┘ │
│            │                │                                     │
│  ┌─────────▼────────────────▼──────────────────────────────────┐ │
│  │                    Persistence Layer                          │ │
│  │  ┌────────────┐  ┌────────────┐  ┌───────────────────┐     │ │
│  │  │ PostgreSQL  │  │   Redis    │  │  S3 / Disk        │     │ │
│  │  │ (metadata,  │  │ (pub/sub,  │  │  (doc snapshots,  │     │ │
│  │  │  versions)  │  │  presence) │  │   binary Yjs)     │     │ │
│  │  └────────────┘  └────────────┘  └───────────────────┘     │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘

Local-first flow:
  1. Edit → apply to local Y.Doc (instant, 0ms)
  2. Y.Doc → persist to IndexedDB/OPFS (async, ~5ms)
  3. Y.Doc → sync to server via WebSocket (async, background)
  4. Server → relay to other clients
  UI never waits on steps 2-4
```

---

## Part 1: Understanding CRDTs (The Theory)

### Why CRDTs Matter

In a collaborative editor, two users can type at the same time. Without conflict resolution, you get data corruption. There are two approaches:

**OT (Operational Transformation):**

- Transforms operations relative to concurrent operations
- Requires a central server to determine operation order
- Complex: Google spent years getting this right for Docs
- Hard to prove correctness

**CRDTs (Conflict-free Replicated Data Types):**

- Data structures that are _mathematically guaranteed_ to converge
- No central authority needed — every peer can merge independently
- Easier to reason about correctness
- Trade-off: slightly more memory usage

### How Yjs CRDTs Work (Under the Hood)

Yjs uses a **list CRDT** variant based on the YATA (Yet Another Transformation Approach) algorithm.

**Core concept:** Every character has a unique ID = `(clientID, clock)`:

- `clientID` — unique per session/device
- `clock` — monotonically increasing counter per client

**Insertion example:**

```
User A types "Hi" → creates items:
  (A, 0) = 'H'  origin: null
  (A, 1) = 'i'  origin: (A, 0)

User B types "!" concurrently after seeing "Hi":
  (B, 0) = '!'  origin: (A, 1)

Both see "Hi!" — no conflict because origins are different.
```

**Concurrent insertion at same position:**

```
Document: "ab"

User A inserts 'X' between a and b → (A, 0) origin: a
User B inserts 'Y' between a and b → (B, 0) origin: a

Conflict! Both have same origin. Yjs breaks ties with clientID:
  If A.clientID < B.clientID → "aXYb"
  If A.clientID > B.clientID → "aYXb"

Both clients converge to the SAME result. Always.
```

**Deletion:**
Items are never removed from the CRDT — they're "tombstoned" (marked deleted). This is why CRDTs use more memory over time, and why garbage collection matters for large documents.

### Yjs Data Types

```typescript
// Y.Text — for rich text (what Lexical uses)
const ytext = ydoc.getText("editor-content");

// Y.Map — for key-value data (metadata, presence)
const ymeta = ydoc.getMap("document-meta");

// Y.Array — for ordered lists (comments, blocks)
const ycomments = ydoc.getArray("comments");

// Y.XmlFragment — for tree structures (Lexical's node tree)
// This is what @lexical/yjs actually uses under the hood
const yxml = ydoc.getXmlFragment("editor-root");
```

---

## Part 2: Project Setup

### Directory Structure

```
collab-editor/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                    # Landing / document list
│   │   ├── doc/[id]/
│   │   │   ├── page.tsx                # Document editor page (SSR initial load)
│   │   │   └── loading.tsx
│   │   └── api/
│   │       ├── documents/
│   │       │   ├── route.ts            # CRUD for documents
│   │       │   └── [id]/
│   │       │       ├── route.ts        # Single doc operations
│   │       │       └── snapshot/
│   │       │           └── route.ts    # Binary Yjs snapshots
│   │       ├── seed/
│   │       │   └── route.ts            # Seed endpoint — pulls from Gutenberg
│   │       └── auth/[...nextauth]/
│   │           └── route.ts
│   │
│   ├── components/
│   │   ├── editor/
│   │   │   ├── CollaborativeEditor.tsx  # Main editor wrapper
│   │   │   ├── LexicalEditor.tsx        # Lexical config + plugins
│   │   │   ├── ToolbarPlugin.tsx
│   │   │   ├── CollaborationPlugin.tsx  # Yjs ↔ Lexical bridge
│   │   │   ├── CursorPlugin.tsx         # Remote cursor rendering
│   │   │   ├── SyncStatus.tsx           # Local-first sync indicator
│   │   │   └── LargeDocPlugin.tsx       # Virtualization for large docs
│   │   ├── presence/
│   │   │   ├── ActiveUsers.tsx          # User avatars / presence bar
│   │   │   └── CursorOverlay.tsx        # Colored cursors with names
│   │   └── ui/
│   │       └── ...
│   │
│   ├── lib/
│   │   ├── yjs/
│   │   │   ├── provider.ts             # Custom WebSocket provider (connect: false option)
│   │   │   ├── awareness.ts            # Presence/cursor awareness
│   │   │   ├── local-persistence.ts    # y-indexeddb wrapper
│   │   │   ├── opfs-persistence.ts     # OPFS for large docs (> 5MB)
│   │   │   ├── persistence-factory.ts  # Auto-selects IndexedDB vs OPFS
│   │   │   └── gc.ts                   # Garbage collection strategies
│   │   ├── ws/
│   │   │   ├── server.ts               # WebSocket server
│   │   │   ├── rooms.ts                # Room management
│   │   │   ├── auth.ts                 # Connection authentication
│   │   │   └── scaling.ts              # Multi-instance coordination
│   │   ├── db/
│   │   │   ├── schema.ts               # Drizzle ORM schema
│   │   │   ├── documents.ts            # Document queries
│   │   │   └── snapshots.ts            # Yjs snapshot persistence
│   │   ├── seed/
│   │   │   ├── gutenberg.ts            # Gutendex API client
│   │   │   ├── text-to-yjs.ts          # Convert plain text → Yjs rich text
│   │   │   └── seed-documents.ts       # Curated document set for demo
│   │   └── utils/
│   │       ├── chunking.ts             # Document chunking for large docs
│   │       ├── compression.ts          # Binary compression utilities
│   │       └── metrics.ts              # Performance monitoring
│   │
│   ├── hooks/
│   │   ├── useCollaboration.ts         # Main hook (local-first init order)
│   │   ├── usePresence.ts              # Awareness/cursor hook
│   │   ├── useReconnect.ts             # Smart reconnection logic
│   │   └── useDocumentChunks.ts        # Lazy loading for large docs
│   │
│   └── types/
│       ├── editor.ts
│       ├── collaboration.ts
│       └── presence.ts
│
├── server/
│   ├── index.ts                         # Custom server entry (ws support)
│   ├── websocket.ts                     # WebSocket upgrade handler
│   └── persistence.ts                   # Server-side Yjs persistence
│
├── public/
│   ├── sw.js                            # Service Worker for offline PWA
│   └── manifest.json                    # PWA manifest
│
├── prisma/
│   └── schema.prisma                    # Or Drizzle if preferred
│
├── docker-compose.yml                   # Postgres + Redis
├── next.config.js                       # With PWA config
├── tsconfig.json
└── package.json
```

### Key Dependencies

```json
{
  "dependencies": {
    "next": "^14",
    "next-pwa": "^5.6",
    "react": "^18",
    "lexical": "^0.17",
    "@lexical/react": "^0.17",
    "@lexical/yjs": "^0.17",
    "yjs": "^13.6",
    "y-protocols": "^1.0",
    "y-indexeddb": "^9.0",
    "lib0": "^0.2",
    "ws": "^8.16",
    "zustand": "^4.5",
    "ioredis": "^5.3",
    "@prisma/client": "^5",
    "next-auth": "^4"
  },
  "devDependencies": {
    "@types/ws": "^8",
    "prisma": "^5"
  }
}
```

---

## Part 3: Core Implementation

### 3.1 — Custom WebSocket Provider

The default `y-websocket` provider works but doesn't give you enough control for a portfolio piece. Build a custom one:

```typescript
// src/lib/yjs/provider.ts
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// Message types (matching y-websocket protocol)
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;
const MSG_QUERY_AWARENESS = 3;

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

interface ProviderOptions {
  awareness?: awarenessProtocol.Awareness;
  token?: string;
  maxReconnectAttempts?: number;
  initialBackoff?: number;
  maxBackoff?: number;
  heartbeatInterval?: number;
}

export class CollaborationProvider {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;

  private ws: WebSocket | null = null;
  private url: string;
  private roomName: string;
  private token: string | undefined;

  // Reconnection state
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private initialBackoff: number;
  private maxBackoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat
  private heartbeatInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;

  // Sync state
  private synced = false;

  // Event listeners
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private syncListeners = new Set<(synced: boolean) => void>();

  // Buffered updates (while disconnected)
  private pendingUpdates: Uint8Array[] = [];

  constructor(
    url: string,
    roomName: string,
    doc: Y.Doc,
    options: ProviderOptions = {},
  ) {
    this.url = url;
    this.roomName = roomName;
    this.doc = doc;
    this.token = options.token;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.initialBackoff = options.initialBackoff ?? 500;
    this.maxBackoff = options.maxBackoff ?? 30000;
    this.heartbeatInterval = options.heartbeatInterval ?? 15000;

    // Listen for local document updates
    this.doc.on("update", this.handleDocUpdate);

    // Listen for awareness changes
    this.awareness.on("update", this.handleAwarenessUpdate);

    this.connect();
  }

  // ---------- Connection lifecycle ----------

  private connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setStatus("connecting");

    const wsUrl = `${this.url}/${this.roomName}${this.token ? `?token=${this.token}` : ""}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.setStatus("connected");
      this.reconnectAttempts = 0;
      this.synced = false;

      // Start sync protocol (step 1: send our state vector)
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoder);

      // Query awareness (get other users' cursors)
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_QUERY_AWARENESS);
      this.send(awarenessEncoder);

      // Send our own awareness
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        [this.doc.clientID],
      );
      const aEncoder = encoding.createEncoder();
      encoding.writeVarUint(aEncoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(aEncoder, awarenessUpdate);
      this.send(aEncoder);

      // Flush any buffered updates
      this.flushPendingUpdates();

      // Start heartbeat
      this.startHeartbeat();
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
          // Handle auth rejection
          console.error("Auth failed");
          this.disconnect();
          break;
      }
    };

    this.ws.onclose = (event) => {
      this.stopHeartbeat();

      if (event.code === 4401) {
        // Auth failure — don't reconnect
        this.setStatus("disconnected");
        return;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  // ---------- Reconnection with exponential backoff + jitter ----------

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setStatus("disconnected");
      return;
    }

    this.setStatus("reconnecting");

    // Exponential backoff with jitter to prevent thundering herd
    const baseDelay = Math.min(
      this.initialBackoff * Math.pow(2, this.reconnectAttempts),
      this.maxBackoff,
    );
    const jitter = baseDelay * (0.5 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, jitter);
  }

  // ---------- Heartbeat (detect dead connections) ----------

  private startHeartbeat() {
    this.lastPong = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPong > this.heartbeatInterval * 2) {
        // No pong received — connection is dead
        this.ws?.close();
        return;
      }

      // Send ping via awareness (lightweight)
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(new Uint8Array([0])); // ping
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  // ---------- Message handlers ----------

  private handleSyncMessage(decoder: decoding.Decoder) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);

    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      this,
    );

    // syncMessageType 1 = SyncStep2 (they sent their diffs)
    // After receiving step 2, we're synced
    if (syncMessageType === 1) {
      this.setSynced(true);
    }

    // If encoder has content (our response), send it
    if (encoding.length(encoder) > 1) {
      this.send(encoder);
    }
  }

  private handleAwarenessMessage(decoder: decoding.Decoder) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
    this.lastPong = Date.now(); // Awareness = implicit heartbeat
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return; // Don't echo server updates

    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Buffer updates while disconnected — flush on reconnect
      this.pendingUpdates.push(update);
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoder);
  };

  private handleAwarenessUpdate = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;

    const changedClients = [...added, ...updated, ...removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
    );
    this.send(encoder);
  };

  // ---------- Buffered updates ----------

  private flushPendingUpdates() {
    if (this.pendingUpdates.length === 0) return;

    // Merge all pending updates into one for efficiency
    const merged = Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, merged);
    this.send(encoder);
  }

  // ---------- Helpers ----------

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
  }

  // ---------- Public API ----------

  onStatus(fn: (status: ConnectionStatus) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onSync(fn: (synced: boolean) => void) {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();

    // Remove awareness before disconnecting
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "disconnect",
    );

    this.ws?.close();
    this.setStatus("disconnected");
  }

  destroy() {
    this.disconnect();
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.statusListeners.clear();
    this.syncListeners.clear();
  }
}
```

### 3.2 — WebSocket Server

```typescript
// server/websocket.ts
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { IncomingMessage } from "http";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

interface Room {
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  lastActivity: number;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

class CollaborationServer {
  private rooms = new Map<string, Room>();
  private wss: WebSocketServer;

  // Persistence callbacks — plug in your DB here
  private loadDocument: (roomName: string) => Promise<Uint8Array | null>;
  private saveDocument: (roomName: string, update: Uint8Array) => Promise<void>;

  // Cleanup idle rooms after 5 minutes
  private IDLE_TIMEOUT = 5 * 60 * 1000;
  // Debounce persistence writes
  private PERSIST_DEBOUNCE = 2000;

  constructor(
    wss: WebSocketServer,
    loadDocument: (name: string) => Promise<Uint8Array | null>,
    saveDocument: (name: string, update: Uint8Array) => Promise<void>,
  ) {
    this.wss = wss;
    this.loadDocument = loadDocument;
    this.saveDocument = saveDocument;

    this.wss.on("connection", this.handleConnection);

    // Periodic cleanup of idle rooms
    setInterval(() => this.cleanupIdleRooms(), 60000);
  }

  private handleConnection = async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const roomName = url.pathname.slice(1); // Remove leading /
    const token = url.searchParams.get("token");

    // Authenticate
    // const user = await this.authenticate(token);
    // if (!user) { ws.close(4401, 'Unauthorized'); return; }

    const room = await this.getOrCreateRoom(roomName);
    room.clients.add(ws);
    room.lastActivity = Date.now();

    // Send sync step 1 (our state vector) to new client
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    ws.send(encoding.toUint8Array(encoder));

    // Send sync step 2 (full document state) to new client
    const encoder2 = encoding.createEncoder();
    encoding.writeVarUint(encoder2, MSG_SYNC);
    syncProtocol.writeSyncStep2(encoder2, room.doc);
    ws.send(encoding.toUint8Array(encoder2));

    // Send current awareness states
    const awarenessStates = awarenessProtocol.encodeAwarenessUpdate(
      room.awareness,
      Array.from(room.awareness.getStates().keys()),
    );
    const aEncoder = encoding.createEncoder();
    encoding.writeVarUint(aEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(aEncoder, awarenessStates);
    ws.send(encoding.toUint8Array(aEncoder));

    // Handle incoming messages
    ws.on("message", (data: ArrayBuffer) => {
      const message = new Uint8Array(data);

      // Single byte = ping
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
      }

      room.lastActivity = Date.now();
    });

    ws.on("close", () => {
      room.clients.delete(ws);

      // Clean up awareness for disconnected client
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        [
          /* clientID from awareness */
        ],
        null,
      );
    });
  };

  private handleSync(decoder: decoding.Decoder, room: Room, sender: WebSocket) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);

    syncProtocol.readSyncMessage(decoder, encoder, room.doc, null);

    // Send response back to sender if needed
    if (encoding.length(encoder) > 1) {
      sender.send(encoding.toUint8Array(encoder));
    }
  }

  private handleAwareness(
    decoder: decoding.Decoder,
    room: Room,
    sender: WebSocket,
  ) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, sender);

    // Broadcast awareness to all OTHER clients
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const message = encoding.toUint8Array(encoder);

    room.clients.forEach((client) => {
      if (client !== sender && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  private async getOrCreateRoom(name: string): Promise<Room> {
    let room = this.rooms.get(name);
    if (room) return room;

    const doc = new Y.Doc();

    // Load persisted state
    const savedState = await this.loadDocument(name);
    if (savedState) {
      Y.applyUpdate(doc, savedState);
    }

    // Listen for updates to persist them (debounced)
    doc.on("update", () => {
      this.schedulePersist(name);
    });

    // Broadcast updates to all clients in room
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const room = this.rooms.get(name);
      if (!room) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      room.clients.forEach((client) => {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });

    const awareness = new awarenessProtocol.Awareness(doc);

    room = {
      name,
      doc,
      awareness,
      clients: new Set(),
      lastActivity: Date.now(),
      persistTimer: null,
    };

    this.rooms.set(name, room);
    return room;
  }

  // Debounced persistence — don't write to DB on every keystroke
  private schedulePersist(roomName: string) {
    const room = this.rooms.get(roomName);
    if (!room) return;

    if (room.persistTimer) clearTimeout(room.persistTimer);

    room.persistTimer = setTimeout(async () => {
      const state = Y.encodeStateAsUpdate(room.doc);
      await this.saveDocument(roomName, state);
    }, this.PERSIST_DEBOUNCE);
  }

  // Memory management: destroy rooms with no active connections
  private cleanupIdleRooms() {
    const now = Date.now();

    this.rooms.forEach((room, name) => {
      if (
        room.clients.size === 0 &&
        now - room.lastActivity > this.IDLE_TIMEOUT
      ) {
        // Persist before cleanup
        const state = Y.encodeStateAsUpdate(room.doc);
        this.saveDocument(name, state);

        room.doc.destroy();
        if (room.persistTimer) clearTimeout(room.persistTimer);
        this.rooms.delete(name);
      }
    });
  }
}

export { CollaborationServer };
```

### 3.3 — Lexical + Yjs Integration

```tsx
// src/components/editor/CollaborativeEditor.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import * as Y from "yjs";
import { CollaborationProvider } from "@/lib/yjs/provider";
import { CursorPlugin } from "./CursorPlugin";
import { ToolbarPlugin } from "./ToolbarPlugin";

interface Props {
  documentId: string;
  userId: string;
  userName: string;
  userColor: string;
}

export function CollaborativeEditor({
  documentId,
  userId,
  userName,
  userColor,
}: Props) {
  const [status, setStatus] = useState<string>("connecting");
  const [synced, setSynced] = useState(false);
  const [activeUsers, setActiveUsers] = useState<Map<number, any>>(new Map());

  // Create stable Yjs doc + provider (once per mount)
  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

    const provider = new CollaborationProvider(
      wsUrl,
      `doc-${documentId}`,
      doc,
      { maxReconnectAttempts: 15 },
    );

    return { doc, provider };
  }, [documentId]);

  // Set up awareness (presence / cursors)
  useEffect(() => {
    provider.awareness.setLocalStateField("user", {
      id: userId,
      name: userName,
      color: userColor,
    });

    const unsubStatus = provider.onStatus(setStatus);
    const unsubSync = provider.onSync(setSynced);

    // Track connected users
    const handleAwarenessChange = () => {
      setActiveUsers(new Map(provider.awareness.getStates()));
    };
    provider.awareness.on("change", handleAwarenessChange);

    return () => {
      unsubStatus();
      unsubSync();
      provider.awareness.off("change", handleAwarenessChange);
      provider.destroy();
      doc.destroy();
    };
  }, [provider, doc, userId, userName, userColor]);

  const initialConfig = {
    namespace: "CollaborativeEditor",
    theme: editorTheme,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
    onError: (error: Error) => console.error("Lexical error:", error),
  };

  return (
    <div className="editor-container">
      {/* Connection status bar */}
      <div className={`status-bar status-${status}`}>
        <span className="status-dot" />
        {status === "connected" && synced ? "Connected" : status}
        {status === "reconnecting" && " — changes saved locally"}
      </div>

      {/* Active users */}
      <div className="active-users">
        {Array.from(activeUsers.entries())
          .filter(([clientId]) => clientId !== doc.clientID)
          .map(([clientId, state]) => (
            <div
              key={clientId}
              className="user-avatar"
              style={{ backgroundColor: state.user?.color }}
              title={state.user?.name}
            >
              {state.user?.name?.[0]?.toUpperCase()}
            </div>
          ))}
      </div>

      <LexicalComposer initialConfig={initialConfig}>
        <ToolbarPlugin />
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor-content" />}
          placeholder={
            <div className="editor-placeholder">Start typing...</div>
          }
          ErrorBoundary={({ children }) => <>{children}</>}
        />
        {/* CollaborationPlugin bridges Lexical ↔ Yjs */}
        <CollaborationPlugin
          id={`doc-${documentId}`}
          providerFactory={(id, yjsDocMap) => {
            // Reuse our existing doc and provider
            yjsDocMap.set(id, doc);
            return provider as any; // Type compatibility
          }}
          shouldBootstrap={false} // Don't create default content
        />
        <CursorPlugin awareness={provider.awareness} />
      </LexicalComposer>
    </div>
  );
}

const editorTheme = {
  paragraph: "editor-paragraph",
  heading: {
    h1: "editor-h1",
    h2: "editor-h2",
    h3: "editor-h3",
  },
  text: {
    bold: "editor-bold",
    italic: "editor-italic",
    underline: "editor-underline",
    code: "editor-code",
  },
};
```

---

## Part 4: Handling Large Datasets

This is where most collaborative editors fall apart. Here are four strategies:

### 4.1 — Document Chunking

For very large documents (100k+ words), don't load the entire Yjs doc at once:

```typescript
// src/lib/utils/chunking.ts

/**
 * Document Chunking Strategy
 *
 * Instead of one massive Y.Doc, split into chunks:
 * - Header chunk (always loaded): title, metadata, TOC
 * - Content chunks (lazy loaded): sections of ~5000 words each
 * - Each chunk is its own Y.Doc with its own WebSocket room
 *
 * Trade-offs:
 * - Pro: Only loads what's visible, much lower memory
 * - Con: Cross-chunk operations (find/replace) need orchestration
 */

interface DocumentChunk {
  id: string;
  documentId: string;
  index: number;
  startOffset: number; // Character offset in full document
  wordCount: number;
  loaded: boolean;
  doc: Y.Doc | null;
}

export class ChunkedDocument {
  private chunks: DocumentChunk[] = [];
  private loadedChunks = new Map<string, Y.Doc>();
  private visibleRange: { start: number; end: number } = { start: 0, end: 0 };

  // Load chunks based on viewport
  async loadVisibleChunks(scrollTop: number, viewportHeight: number) {
    const visibleChunks = this.getChunksInRange(scrollTop, viewportHeight);

    // Preload 1 chunk above and below viewport
    const preloadRange = this.expandRange(visibleChunks, 1);

    for (const chunk of preloadRange) {
      if (!chunk.loaded) {
        await this.loadChunk(chunk.id);
      }
    }

    // Unload chunks far from viewport (memory management)
    const unloadRange = this.getChunksOutsideRange(preloadRange);
    for (const chunk of unloadRange) {
      if (chunk.loaded) {
        this.unloadChunk(chunk.id);
      }
    }
  }

  private async loadChunk(chunkId: string) {
    const response = await fetch(
      `/api/documents/${this.documentId}/chunks/${chunkId}`,
    );
    const state = new Uint8Array(await response.arrayBuffer());

    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);

    this.loadedChunks.set(chunkId, doc);

    // Connect chunk to its own WebSocket room
    // new CollaborationProvider(wsUrl, `chunk-${chunkId}`, doc);
  }

  private unloadChunk(chunkId: string) {
    const doc = this.loadedChunks.get(chunkId);
    if (doc) {
      // Persist before unloading
      doc.destroy();
      this.loadedChunks.delete(chunkId);
    }
  }
}
```

### 4.2 — Yjs Garbage Collection & Snapshots

```typescript
// src/lib/yjs/gc.ts

/**
 * CRDT Garbage Collection
 *
 * Problem: CRDTs never truly delete — they tombstone. Over time,
 * a document accumulates massive tombstone overhead.
 *
 * Solution: Periodic snapshots that compress the CRDT state.
 */

import * as Y from "yjs";

export class DocumentGC {
  /**
   * Create a compacted snapshot.
   *
   * Y.encodeStateAsUpdate captures current state WITHOUT tombstones
   * from operations that all clients have already seen (based on
   * the state vector).
   *
   * This is safe because:
   * 1. All connected clients have synced past these operations
   * 2. The snapshot represents the "ground truth" at this point
   * 3. New clients receive the snapshot instead of replaying history
   */
  static createSnapshot(doc: Y.Doc): {
    snapshot: Uint8Array;
    stateVector: Uint8Array;
    timestamp: number;
  } {
    return {
      snapshot: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      timestamp: Date.now(),
    };
  }

  /**
   * Load from snapshot + apply any updates that happened after.
   */
  static restoreFromSnapshot(
    snapshot: Uint8Array,
    recentUpdates: Uint8Array[],
  ): Y.Doc {
    const doc = new Y.Doc();

    // Apply base snapshot
    Y.applyUpdate(doc, snapshot);

    // Apply subsequent updates in order
    for (const update of recentUpdates) {
      Y.applyUpdate(doc, update);
    }

    return doc;
  }

  /**
   * Measure document overhead to decide when to snapshot.
   */
  static measureOverhead(doc: Y.Doc): {
    stateSize: number; // Current state in bytes
    estimatedTombstones: number; // Approximate deleted items
    shouldGC: boolean;
  } {
    const state = Y.encodeStateAsUpdate(doc);

    // Heuristic: if state > 1MB, consider GC
    return {
      stateSize: state.byteLength,
      estimatedTombstones: 0, // Would need internal Yjs access
      shouldGC: state.byteLength > 1024 * 1024,
    };
  }
}
```

### 4.3 — Binary Compression for Network Efficiency

```typescript
// src/lib/utils/compression.ts

/**
 * Compression for large Yjs updates over WebSocket.
 *
 * Yjs updates are already binary, but for large documents
 * we can compress them further.
 */

// Use built-in CompressionStream API (modern browsers)
export async function compressUpdate(update: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([update])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));

  const compressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(compressed);
}

export async function decompressUpdate(
  compressed: Uint8Array,
): Promise<Uint8Array> {
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));

  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

/**
 * Update batching — don't send every keystroke individually.
 * Collect updates for a short window, merge, then send.
 */
export class UpdateBatcher {
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushCallback: (merged: Uint8Array) => void;
  private batchWindow: number;

  constructor(
    flushCallback: (merged: Uint8Array) => void,
    batchWindow = 50, // ms — collect updates for 50ms then flush
  ) {
    this.flushCallback = flushCallback;
    this.batchWindow = batchWindow;
  }

  add(update: Uint8Array) {
    this.pending.push(update);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.batchWindow);
    }
  }

  private flush() {
    this.timer = null;

    if (this.pending.length === 0) return;

    // Y.mergeUpdates combines multiple updates into one
    // This is much more efficient than sending individually
    const merged = Y.mergeUpdates(this.pending);
    this.pending = [];

    this.flushCallback(merged);
  }
}
```

### 4.4 — Performance Monitoring

```typescript
// src/lib/utils/metrics.ts

/**
 * Performance metrics to show in your portfolio demo.
 * Display these as a dashboard panel to impress reviewers.
 */

export class CollaborationMetrics {
  private syncLatencies: number[] = [];
  private updateSizes: number[] = [];
  private reconnectCount = 0;

  recordSyncLatency(ms: number) {
    this.syncLatencies.push(ms);
    if (this.syncLatencies.length > 100) this.syncLatencies.shift();
  }

  recordUpdateSize(bytes: number) {
    this.updateSizes.push(bytes);
    if (this.updateSizes.length > 100) this.updateSizes.shift();
  }

  recordReconnect() {
    this.reconnectCount++;
  }

  getStats() {
    return {
      avgSyncLatency: average(this.syncLatencies),
      p95SyncLatency: percentile(this.syncLatencies, 0.95),
      avgUpdateSize: average(this.updateSizes),
      totalUpdates: this.updateSizes.length,
      reconnects: this.reconnectCount,
      documentSize: 0, // Set from Y.encodeStateAsUpdate
      activeConnections: 0, // Set from awareness
    };
  }
}

function average(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)] ?? 0;
}
```

---

## Part 5: Database Schema

```sql
-- Prisma schema (schema.prisma)

-- Documents table
-- stores document metadata, not content (content is in Yjs binary)

model Document {
  id          String   @id @default(cuid())
  title       String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String   // userId

  snapshots   Snapshot[]
  updates     DocumentUpdate[]

  @@index([createdBy])
}

-- Snapshots: periodic compacted Yjs state
model Snapshot {
  id          String   @id @default(cuid())
  documentId  String
  document    Document @relation(fields: [documentId], references: [id])
  data        Bytes    // Binary Yjs state
  stateVector Bytes    // For incremental sync
  createdAt   DateTime @default(now())

  @@index([documentId, createdAt])
}

-- Updates: incremental Yjs updates since last snapshot
-- These are append-only and cleared after snapshotting
model DocumentUpdate {
  id          String   @id @default(cuid())
  documentId  String
  document    Document @relation(fields: [documentId], references: [id])
  data        Bytes    // Binary Yjs update
  clientId    Int      // Which Yjs client produced this
  createdAt   DateTime @default(now())

  @@index([documentId, createdAt])
}
```

---

## Part 6: Portfolio Demo Features

Things that make interviewers go "wow":

### Must-haves

- [ ] **Local-first architecture** — edits are instant (0ms), app works fully offline
- [ ] **Multi-cursor presence** — see other users' cursors with their name + color
- [ ] **Offline editing** — edit offline indefinitely, auto-sync when reconnected
- [ ] **Sync status indicator** — local-only / syncing / synced / offline with pending count
- [ ] **Conflict-free concurrent editing** — two users typing in same paragraph simultaneously
- [ ] **Version history** — snapshots with "restore to this version" functionality
- [ ] **Real content at scale** — seeded with Project Gutenberg books from 2K to 580K+ words

### Impressive extras

- [ ] **Performance dashboard** — live metrics (sync latency, document size, update frequency)
- [ ] **Tiered storage** — auto-upgrades from IndexedDB to OPFS for large documents
- [ ] **PWA with Service Worker** — installable, loads from cold start offline
- [ ] **Simulated latency mode** — add artificial delay to show how CRDTs handle it
- [ ] **Document diff viewer** — visual diff between snapshots using Y.js merging
- [ ] **Stress test mode** — simulate 10+ concurrent users with random edits
- [ ] **Network partition demo** — manually disconnect clients, edit on both sides, reconnect and show convergence

### The "explain it" factor

Add a collapsible panel that explains what's happening:

- Show the CRDT operation log in real-time
- Visualize the Yjs item tree structure
- Show binary update sizes and compression ratios
- Display local vs server sync state delta

---

## Part 7: Seed Data — Project Gutenberg

Use public domain books from Project Gutenberg to populate the app with realistic content at varying sizes. This demonstrates how your architecture handles everything from a quick note to a massive manuscript.

### Data Source

**Gutendex API** (https://gutendex.com) — free, no API key needed. Returns metadata + download links for 76,000+ public domain books.

```
GET https://gutendex.com/books/?search=pride+and+prejudice
→ Returns JSON with download URLs for full text
```

### Curated Seed Documents

| Document                                     | Gutenberg ID | Words    | Demo Purpose              |
| -------------------------------------------- | ------------ | -------- | ------------------------- |
| "The Yellow Wallpaper" (Gilman)              | 1952         | ~6,000   | Quick editing, basic demo |
| "Alice's Adventures in Wonderland" (Carroll) | 11           | ~27,000  | Normal use case           |
| "Pride and Prejudice" (Austen)               | 1342         | ~122,000 | Chunking kicks in         |
| "Moby Dick" (Melville)                       | 2701         | ~215,000 | Heavy document, GC demo   |
| "War and Peace" (Tolstoy)                    | 2600         | ~580,000 | Stress test, OPFS trigger |
| Combined anthology (10+ short stories)       | Various      | ~50,000  | Multi-section document    |

### Seed Script Architecture

```typescript
// src/lib/seed/gutenberg.ts

const GUTENDEX_API = "https://gutendex.com/books";

interface GutenbergBook {
  id: number;
  title: string;
  authors: { name: string }[];
  formats: Record<string, string>; // MIME type → URL
}

/**
 * Fetch book metadata from Gutendex.
 * No API key needed.
 */
export async function fetchBookMetadata(id: number): Promise<GutenbergBook> {
  const res = await fetch(`${GUTENDEX_API}/${id}`);
  return res.json();
}

/**
 * Download full plain text of a book.
 * Prefers UTF-8 plain text format.
 */
export async function downloadBookText(book: GutenbergBook): Promise<string> {
  const textUrl =
    book.formats["text/plain; charset=utf-8"] ||
    book.formats["text/plain"] ||
    book.formats["text/plain; charset=us-ascii"];

  if (!textUrl) throw new Error(`No plain text format for ${book.title}`);

  const res = await fetch(textUrl);
  return res.text();
}

/**
 * Strip Gutenberg header/footer boilerplate.
 * Books have "*** START OF THE PROJECT GUTENBERG EBOOK ***"
 * and "*** END OF THE PROJECT GUTENBERG EBOOK ***" markers.
 */
export function cleanGutenbergText(raw: string): string {
  const startMarker =
    /\*\*\* START OF (THE|THIS) PROJECT GUTENBERG EBOOK .+? \*\*\*/i;
  const endMarker =
    /\*\*\* END OF (THE|THIS) PROJECT GUTENBERG EBOOK .+? \*\*\*/i;

  const startMatch = raw.match(startMarker);
  const endMatch = raw.match(endMarker);

  let text = raw;
  if (startMatch?.index !== undefined) {
    text = text.slice(startMatch.index + startMatch[0].length);
  }
  if (endMatch?.index !== undefined) {
    text = text.slice(0, endMatch.index);
  }

  return text.trim();
}
```

```typescript
// src/lib/seed/text-to-yjs.ts
import * as Y from "yjs";

/**
 * Convert plain text into a Y.Doc with rich text structure.
 *
 * Parses headings (ALL CAPS lines, "CHAPTER X" patterns),
 * paragraphs (double newlines), and preserves structure
 * so Lexical renders it properly.
 */
export function textToYDoc(text: string, docName: string): Y.Doc {
  const doc = new Y.Doc();
  const yxml = doc.getXmlFragment("root");

  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Detect chapter headings (e.g., "CHAPTER I.", "CHAPTER 1")
    const isHeading =
      /^(CHAPTER|BOOK|PART|ACT|SCENE)\s+[IVXLCDM\d]+/i.test(trimmed) ||
      (trimmed === trimmed.toUpperCase() && trimmed.length < 100);

    const element = new Y.XmlElement(isHeading ? "heading" : "paragraph");

    if (isHeading) {
      element.setAttribute("tag", "h2");
    }

    const textNode = new Y.XmlText();
    textNode.insert(0, trimmed);
    element.insert(0, [textNode]);

    yxml.insert(yxml.length, [element]);
  }

  return doc;
}
```

```typescript
// src/lib/seed/seed-documents.ts

const SEED_BOOKS = [
  { id: 1952, label: "Short Story" },
  { id: 11, label: "Novella" },
  { id: 1342, label: "Novel" },
  { id: 2701, label: "Large Novel" },
  { id: 2600, label: "Stress Test" },
];

/**
 * Seed the app with Gutenberg books at varying sizes.
 * Call via: POST /api/seed
 *
 * Each book becomes a Y.Doc, persisted to PostgreSQL
 * as a binary Yjs snapshot.
 */
export async function seedDocuments() {
  for (const { id, label } of SEED_BOOKS) {
    const meta = await fetchBookMetadata(id);
    const raw = await downloadBookText(meta);
    const clean = cleanGutenbergText(raw);
    const doc = textToYDoc(clean, meta.title);
    const snapshot = Y.encodeStateAsUpdate(doc);

    // Persist to database
    await db.document.create({
      data: {
        title: `${meta.title} — ${meta.authors[0]?.name ?? "Unknown"}`,
        label,
        wordCount: clean.split(/\s+/).length,
      },
    });

    await db.snapshot.create({
      data: {
        documentId: doc.id,
        data: Buffer.from(snapshot),
        stateVector: Buffer.from(Y.encodeStateVector(doc)),
      },
    });

    doc.destroy();

    // Be polite to Gutenberg servers
    await new Promise((r) => setTimeout(r, 2000));
  }
}
```

### Alternative Data Sources

If you want variety beyond literature, these are also excellent and free:

| Source                                                 | Content Type                              | Size                | Best For                                            |
| ------------------------------------------------------ | ----------------------------------------- | ------------------- | --------------------------------------------------- |
| **Wikipedia Structured Contents** (Kaggle/HuggingFace) | Encyclopaedia articles as structured JSON | 6.7M+ articles      | Rich structured content with headings, lists, links |
| **Simple Wikipedia** (HuggingFace)                     | Simplified encyclopedia                   | ~200MB              | Lighter dev/test alternative                        |
| **Hugging Face `manu/project_gutenberg`**              | 70K+ books, streamable                    | ~30GB full          | Bulk loading without API rate limits                |
| **Internet Archive Open Library**                      | Book metadata + some full text            | Millions of entries | If you add a library/catalog view                   |

---

## Part 8: Implementation Order

Follow this sequence to build incrementally with working milestones:

### Phase 1: Foundation (Week 1)

1. Next.js project setup with TypeScript
2. Basic Lexical editor (no collaboration yet)
3. Toolbar with formatting (bold, italic, headings, lists)
4. Basic styling and layout

### Phase 2: Local-First Foundation (Week 2)

5. Set up Y.Doc with `y-indexeddb` persistence
6. Verify: edit document → refresh page → content restored from IndexedDB
7. Build the `useCollaboration` hook with local-first init order
8. Implement sync status state machine (`loading-local → local-only → syncing → synced`)
9. Build the SyncStatus UI component

### Phase 3: Network Collaboration (Week 3)

10. Build the WebSocket server (standalone Node process)
11. Build the custom WebSocket provider (with `connect: false` option)
12. Connect provider AFTER local persistence is loaded
13. Get two browser tabs syncing in real-time
14. Verify: disconnect one tab, edit on both, reconnect → changes merge

### Phase 4: Presence & UX (Week 3-4)

15. Awareness protocol — cursor positions + user info
16. Render remote cursors with colored carets
17. Active users bar with avatars
18. Exponential backoff reconnection logic with jitter

### Phase 5: Persistence & Seed Data (Week 4)

19. PostgreSQL setup (Docker Compose)
20. Server-side Yjs persistence (snapshots + updates)
21. Build Gutenberg seed script (fetch → clean → convert to Y.Doc → persist)
22. Seed curated documents at varying sizes (6K → 580K words)
23. Verify: large documents load and edit smoothly

### Phase 6: Large Document Handling (Week 5)

24. Document chunking strategy
25. Lazy loading chunks based on scroll position
26. Update batching and compression
27. Garbage collection / snapshot compaction
28. OPFS persistence for documents > 5MB
29. Tiered storage factory (auto-selects IndexedDB vs OPFS)

### Phase 7: Portfolio Polish (Week 6)

30. Performance metrics dashboard
31. CRDT operation visualizer
32. Stress test / demo mode
33. Version history with diff viewer
34. Service Worker + PWA manifest (true offline)
35. README with architecture diagrams
36. Deploy (Vercel + Railway/Fly.io for WebSocket server)

---

## Key Concepts to Be Ready to Explain in Interviews

1. **"How do CRDTs guarantee convergence?"** — Every operation has a unique ID (clientID + clock). Concurrent operations at the same position are ordered deterministically by clientID. All peers apply the same ordering rules, so they always converge.

2. **"What's the trade-off between CRDTs and OT?"** — CRDTs use more memory (tombstones), but don't need a central server. OT is more memory-efficient but requires a centralized transformation server and is much harder to implement correctly.

3. **"Why local-first?"** — It gives users data ownership, instant responsiveness, and true offline capability. The CRDT (Yjs) makes this possible because it guarantees convergence without a server being involved in conflict resolution. The server is a relay and backup, not an authority.

4. **"How do you handle the initial load?"** — Load from IndexedDB first (< 50ms), render immediately, then sync with the server in the background. Users never see a loading spinner for their own documents.

5. **"How do you handle a user going offline?"** — Edits persist to IndexedDB immediately. The WebSocket provider buffers updates. On reconnection, buffered updates are merged via `Y.mergeUpdates()` and sent as a single sync message. The CRDT guarantees correctness regardless of offline duration.

6. **"How do you handle large documents?"** — Four strategies: (1) Document chunking — split into sections, each a separate Y.Doc with lazy loading. (2) Snapshot compaction — periodically encode state without tombstones. (3) Update batching — collect keystroke updates for 50ms windows, merge, then send. (4) Tiered storage — auto-upgrade from IndexedDB to OPFS for documents > 5MB to avoid serialization bottlenecks.

7. **"What happens during a network partition?"** — Both sides continue editing independently using their local Y.Doc. When the partition heals, the CRDT merge algorithm ensures all operations are integrated. This is the key advantage over OT — no central server needed for correctness.

8. **"How do you scale to many concurrent users?"** — Redis pub/sub for multi-server WebSocket coordination. Each server holds rooms in memory; Redis broadcasts updates across servers. Awareness (cursors) uses the same channel with shorter TTLs.

9. **"How did you handle seeding realistic data?"** — I pull public domain books from Project Gutenberg via the Gutendex API, strip the boilerplate headers/footers, parse the text into structured rich text (detecting chapter headings, paragraphs), and convert it into Y.Doc binary snapshots. This gives me a natural gradient from 6K to 580K+ words to demonstrate how the architecture scales.

10. **"What about storage limits for local-first?"** — IndexedDB typically has a quota of 50-80% of available disk space per origin. For documents exceeding ~5MB, I implemented an automatic upgrade path to OPFS (Origin Private File System), which has better performance for large binary data because it avoids IndexedDB's structured cloning overhead.
