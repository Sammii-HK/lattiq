# WebSockets & The Sync Protocol

## Why WebSockets (Not HTTP, SSE, or WebRTC)

For real-time collaboration, you need a way to push updates between clients.
Here are the options:

### HTTP Polling
```
Client: "Any updates?" → Server: "No"     (every 1 second)
Client: "Any updates?" → Server: "No"
Client: "Any updates?" → Server: "Yes, here's an update"
```
**Problems:** High latency (up to 1s delay), wasteful (99% of requests
return nothing), doesn't scale.

### Server-Sent Events (SSE)
```
Client opens connection → Server pushes updates as they happen
```
**Problems:** One-directional (server → client only). The client still
needs HTTP requests to send its own updates. Two different protocols for
two directions is messy.

### WebRTC
```
Client A ←──── direct connection ────→ Client B
```
**Problems:** Peer-to-peer is great for 2 users but gets complicated fast
with 5+ users (mesh networking). NAT traversal is unreliable. No server
backup of data.

### WebSockets (what we're using)
```
Client A ←──→ Server ←──→ Client B
             ←──→ Client C
```
**Why it wins:**
- Bidirectional — both client and server can send at any time
- Low latency — persistent connection, no HTTP overhead per message
- Binary support — we send Yjs updates as raw bytes, not JSON
- Well-supported — works in all browsers, easy server implementation
- Scalable — server can manage rooms, fan out updates efficiently

---

## How WebSockets Work (The Basics)

### The Handshake
WebSocket connections start as an HTTP request that gets "upgraded":

```
Client → Server:
  GET /ws/doc-123 HTTP/1.1
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==

Server → Client:
  HTTP/1.1 101 Switching Protocols
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

After this handshake, the HTTP connection becomes a WebSocket connection.
Both sides can now send messages freely without HTTP overhead.

### Message Types
WebSocket messages can be:
- **Text** — UTF-8 strings (we don't use this much)
- **Binary** — raw bytes (this is what Yjs uses — it's much more efficient)
- **Ping/Pong** — keep-alive frames built into the protocol

### Connection Lifecycle
```
1. Client opens connection
2. Handshake completes
3. Both sides send messages freely
4. Either side can close the connection
5. Client implements reconnection logic
```

---

## The Yjs Sync Protocol

Yjs has its own protocol that runs over WebSocket. Every message starts
with a type byte:

```
Message types:
  0 = MSG_SYNC       — document synchronization
  1 = MSG_AWARENESS   — cursor/presence updates
  2 = MSG_AUTH        — authentication (optional)
  3 = MSG_QUERY_AWARENESS — request current awareness states
```

### The Sync Handshake (MSG_SYNC)

When a client connects, it syncs its document with the server:

```
Step 1: Client → Server
  [MSG_SYNC, SyncStep1, stateVector]
  "Here's a summary of what I have. Send me what I'm missing."

Step 2: Server → Client
  [MSG_SYNC, SyncStep2, missingUpdates]
  "Here are the updates you don't have yet."

Step 3: Server → Client (also)
  [MSG_SYNC, SyncStep1, serverStateVector]
  "Now here's what I have. Send me what I'm missing."

Step 4: Client → Server
  [MSG_SYNC, SyncStep2, clientMissingUpdates]
  "Here are the updates you don't have."
```

After these 4 messages, both sides have identical document state. This
works regardless of how long they've been disconnected.

**The state vector** is the key to efficiency. Instead of sending the
entire document, each side sends a compact summary (~100 bytes) of what
it has, and the other side sends only what's missing.

### Continuous Updates

After initial sync, every edit is sent as an incremental update:

```
Client types a character:
  Lexical → Y.Doc update event → Provider → WebSocket
  [MSG_SYNC, Update, binaryDelta]

Server receives, applies to its Y.Doc, relays to other clients:
  Server Y.Doc → all other WebSockets
  [MSG_SYNC, Update, binaryDelta]
```

These updates are tiny (typically 20-100 bytes per keystroke) because
they only contain the delta, not the full document.

---

## Awareness Protocol (Cursors & Presence)

Awareness is a separate channel from document sync. It handles ephemeral
state that doesn't need to be persisted:

- Cursor position and selection
- User name and color
- "Is typing" indicator
- Online status

```typescript
// Setting your awareness state
provider.awareness.setLocalStateField('user', {
  name: 'Alice',
  color: '#FF6B6B',
})

// Setting cursor position (Lexical does this automatically via @lexical/yjs)
provider.awareness.setLocalStateField('cursor', {
  anchor: { key: 'node-5', offset: 12 },
  focus: { key: 'node-5', offset: 12 },
})

// Listening for other users' awareness changes
provider.awareness.on('change', () => {
  const states = provider.awareness.getStates()
  // states is a Map<clientID, { user, cursor, ... }>
  // Use this to render remote cursors and the active users bar
})
```

**Why awareness is separate from document sync:**
- Cursor positions change on every keystroke but don't need persistence
- If a user disconnects, their cursor should disappear (TTL-based cleanup)
- Awareness updates are broadcast, not merged — latest state wins

---

## Reconnection Strategy

Networks are unreliable. A good reconnection strategy is essential:

### Exponential Backoff with Jitter

When a connection drops, don't immediately reconnect in a tight loop.
Instead:

```
Attempt 1: wait  500ms + random(0-250ms)
Attempt 2: wait 1000ms + random(0-500ms)
Attempt 3: wait 2000ms + random(0-1000ms)
Attempt 4: wait 4000ms + random(0-2000ms)
...
Max:        wait 30000ms + random(0-15000ms)
```

**Why exponential:** If the server is down, hammering it with connection
attempts makes things worse. Backing off gives the server time to recover.

**Why jitter (random delay):** If 100 clients disconnect at the same time
(server restart), they'd all reconnect at the same intervals (500ms, 1s,
2s...) creating "thundering herd" spikes. Adding randomness spreads out
the reconnection attempts.

### What Happens to Edits During Disconnect?

This is where local-first shines:

```
1. User keeps editing (local Y.Doc + IndexedDB, no interruption)
2. Provider buffers all Y.Doc updates that couldn't be sent
3. On reconnect: exchange state vectors (sync protocol steps 1-4)
4. Buffered updates are merged via Y.mergeUpdates() and sent
5. The CRDT guarantees everything merges correctly
```

The user never even needs to know the connection dropped, unless you choose
to show a subtle indicator.

---

## Binary Protocol Efficiency

Everything in the Yjs protocol is binary — no JSON parsing overhead:

```
A typical keystroke update:
  JSON equivalent: {"type":"insert","pos":42,"char":"a","clientId":12345,"clock":67}
  → ~70 bytes as JSON text

  Yjs binary:     [0, 1, 12345, 67, 42, 1, 97]
  → ~15 bytes as binary

  That's ~80% smaller.
```

This matters because:
- Less bandwidth used (important on mobile)
- Less CPU for encoding/decoding (no JSON.parse)
- Lower latency (smaller messages transmit faster)

The `lib0` library (a dependency of Yjs) provides the encoding/decoding:

```typescript
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// Encoding a message
const encoder = encoding.createEncoder()
encoding.writeVarUint(encoder, 0)           // message type
encoding.writeVarUint8Array(encoder, data)  // binary payload
const message = encoding.toUint8Array(encoder)
// → compact binary Uint8Array

// Decoding a message
const decoder = decoding.createDecoder(message)
const msgType = decoding.readVarUint(decoder)   // → 0
const payload = decoding.readVarUint8Array(decoder) // → data
```

**VarUint encoding:** Small numbers use fewer bytes. The number 5 uses
1 byte, not 4. The number 300 uses 2 bytes. This is why the protocol
is so compact.

---

## Server Room Management

Our WebSocket server organizes connections into "rooms" — one per document:

```
WebSocket Server
├── Room: "doc-abc123"
│   ├── Y.Doc (server-side mirror)
│   ├── Awareness state
│   ├── Client A (WebSocket connection)
│   ├── Client B (WebSocket connection)
│   └── Client C (WebSocket connection)
│
├── Room: "doc-def456"
│   ├── Y.Doc
│   ├── Awareness state
│   └── Client D
│
└── Room: "doc-ghi789"
    ├── Y.Doc
    └── (no clients — idle, will be cleaned up)
```

Key server behaviors:
- **Create room on first connection** — load Y.Doc state from PostgreSQL
- **Broadcast updates** — when one client sends an update, relay to all others in the room
- **Persist debounced** — don't write to DB on every keystroke; batch writes every 2 seconds
- **Cleanup idle rooms** — destroy room + Y.Doc after 5 minutes with no connections

---

## Key Takeaways

1. **WebSockets give us bidirectional, low-latency, binary communication**
   — perfect for real-time CRDT sync.

2. **The Yjs sync protocol is state-vector-based** — clients only exchange
   what the other is missing, making reconnection efficient regardless of
   offline duration.

3. **Awareness is separate from document sync** — cursors and presence are
   ephemeral and don't need CRDT guarantees.

4. **Exponential backoff + jitter** prevents thundering herd on reconnection
   and is kind to the server.

5. **Binary encoding is ~80% smaller than JSON** — the Yjs protocol is
   optimized for minimal bandwidth and CPU usage.

---

## Further Reading

- [WebSocket API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [y-protocols source](https://github.com/yjs/y-protocols) — the actual sync protocol code
- [lib0 encoding](https://github.com/dmonad/lib0) — the binary encoding library
- [Exponential backoff explained](https://cloud.google.com/iot/docs/how-tos/exponential-backoff)
