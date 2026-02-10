# Local-First Architecture — The Philosophy and Practice

## What "Local-First" Actually Means

Most web apps work like this:

```
Traditional app:
  User types → sends to server → server saves → server responds → UI updates
  Latency: 50-500ms per action
  Offline: broken
```

Local-first flips this:

```
Local-first app:
  User types → updates local data (instant, 0ms) → UI updates immediately
                  ↓ (background, async)
              syncs to server whenever possible
  Latency: 0ms for the user
  Offline: fully functional
```

**The core principle:** your local device is the primary data store.
The server is a backup and relay, not the source of truth.

This is a fundamental shift from how most web apps work. Most React apps
treat the server as the source of truth and the client as a cache. In
local-first, the client IS the truth, and the server is the cache.

---

## Why This Matters (Beyond Buzzwords)

### 1. Instant Responsiveness
No loading spinners, no "saving...", no waiting. Every action feels instant
because it IS instant — it's modifying local data.

### 2. Works Offline
Not "graceful degradation" — actually works. Edit a document on an airplane,
close your laptop, open it at home, and your changes sync automatically.

### 3. Data Ownership
The user's data lives on their device. If your server goes down, they still
have everything. This is a real concern — how many Google Docs would you
lose if Google's servers were unreachable?

### 4. Reduced Server Costs
The server doesn't process every keystroke. It only relays updates between
clients and stores backups. This is dramatically cheaper to operate.

---

## The Architecture in Our App

Here's the initialization order — this is critical to get right:

```
1. User opens document
   │
2. Load from IndexedDB (local storage)     ← FIRST, always
   │  Takes ~5-50ms
   │  If data exists: render immediately
   │  If no data: show empty editor
   │
3. Start Yjs Y.Doc with local data         ← SECOND
   │  The Y.Doc is now the source of truth
   │  Editor is fully functional at this point
   │
4. Connect WebSocket provider               ← THIRD, optional
   │  connect: false initially, then connect after step 3
   │  Exchange state vectors with server
   │  Merge any remote changes (CRDT handles conflicts)
   │
5. Continuous sync                          ← BACKGROUND
   Local edits → Y.Doc → IndexedDB (always)
                       → WebSocket (when online)
```

**Why this order matters:**
- Steps 1-3 complete in < 100ms. The user can start editing immediately.
- Step 4 might take 200ms-5s depending on network. The user doesn't wait.
- If step 4 fails (offline), that's fine. Steps 1-3 are fully functional.

---

## The Sync Status State Machine

Our app tracks where it is in the sync lifecycle:

```
                          ┌─────────────┐
                          │ loading-    │ ← App just opened,
                          │ local       │   reading from IndexedDB
                          └──────┬──────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
              ┌─────│     local-only         │←────────────┐
              │     │ (editing, no server)   │             │
              │     └────────────┬───────────┘             │
              │                  │                          │
              │        WebSocket connects                 │
              │                  │                WebSocket disconnects
              │                  ▼                          │
              │     ┌────────────────────────┐             │
              │     │      syncing           │─────────────┘
              │     │ (exchanging updates)   │
              │     └────────────┬───────────┘
              │                  │
              │        All updates exchanged
              │                  │
              │                  ▼
              │     ┌────────────────────────┐
              │     │      synced            │─── edit ──→ syncing
              │     │ (fully up to date)     │
              │     └────────────────────────┘
              │
              │  (if never connects)
              └──→  App works fine in local-only mode forever
```

The UI shows this status so users always know the state of their data.

---

## Persistence Layers

We use two levels of local persistence:

### IndexedDB (via y-indexeddb)
- **What:** Browser database, available in all modern browsers
- **Capacity:** Typically 50-80% of available disk space per origin
- **Speed:** ~5ms for small docs, ~50ms for large docs
- **Best for:** Documents under ~5MB
- **How it works:** `y-indexeddb` automatically persists every Y.Doc update
  to IndexedDB. On reload, it restores the full document state.

```typescript
import { IndexeddbPersistence } from 'y-indexeddb'

// This single line gives you persistent, offline-capable storage
const persistence = new IndexeddbPersistence('doc-123', ydoc)

// It fires 'synced' when the local state is fully loaded
persistence.on('synced', () => {
  console.log('Local data loaded — editor is ready')
})
```

### OPFS (Origin Private File System) — for large docs
- **What:** A newer browser API that gives web apps a private file system
- **Capacity:** Same as IndexedDB, but better performance for large binary data
- **Speed:** Much faster than IndexedDB for large docs (no structured cloning)
- **Best for:** Documents over 5MB
- **Why:** IndexedDB stores data via "structured cloning," which serializes
  and deserializes the entire value. For a 10MB Yjs document, this adds
  significant overhead. OPFS works with raw binary streams.

We'll implement a factory that automatically picks the right storage:
- Document < 5MB → IndexedDB
- Document >= 5MB → OPFS

---

## Conflict Resolution in Practice

The beauty of using Yjs is that conflict resolution is handled for you.
But it helps to understand what happens:

### Scenario: Offline Editing on Two Devices

```
Timeline:
─────────────────────────────────────────────────────

Alice (laptop):     "Hello World"
  │                      │
  │  Goes offline        │
  │                      │
  ├── Edits: "Hello World! This is Alice."
  │
  │                 Bob (phone):
  │                   │
  │                   ├── Edits: "Hello World. Bob was here."
  │                   │
  │  Comes online     │
  │        │          │
  │        ▼          │
  │   Sync happens    │
  │                   │
  ▼                   ▼
Both see: "Hello World! This is Alice.. Bob was here."
```

Wait — that looks a bit garbled. And that's accurate! CRDTs guarantee
**convergence** (both users see the same thing), but they don't guarantee
**intent**. The result preserves all edits but might not read naturally.

This is a known limitation and is why most collaborative editors also have:
- Undo/redo per user
- Version history (so you can go back)
- Visual indicators of who changed what

For our app, the CRDT correctness is the important part. The edge cases
where merged text reads awkwardly are rare in practice (most concurrent
edits happen in different parts of the document).

---

## The Server's Role (Relay, Not Authority)

In a traditional app, the server validates and stores everything.
In our local-first app, the server has three jobs:

### 1. Relay
Pass Yjs updates between connected clients. That's it. The server doesn't
interpret or validate the CRDT data — it just forwards binary blobs.

### 2. Backup
Periodically snapshot the Y.Doc state to PostgreSQL. This is insurance:
if a user clears their browser data, they can recover from the server.

### 3. Initial Sync for New Clients
When a new device opens a document for the first time, it has no local
data. The server provides the current Y.Doc state so the new client can
bootstrap quickly.

The server is NOT involved in conflict resolution. That happens entirely
within Yjs on each client.

---

## Key Takeaways

1. **Local-first = local data is the source of truth.** The server is a
   backup and relay.

2. **Load order matters:** IndexedDB first, then Y.Doc, then WebSocket.
   The user never waits for the network.

3. **The sync status state machine** communicates trust to the user:
   they always know if their data is local-only, syncing, or fully synced.

4. **CRDTs guarantee convergence, not intent.** All users will see the
   same result, but heavily concurrent edits in the same spot may read
   awkwardly. This is acceptable and rare in practice.

5. **The server does three things:** relay, backup, and bootstrap new
   clients. It never resolves conflicts.

---

## Further Reading

- [Local-first software](https://www.inkandswitch.com/local-first/) —
  the foundational paper by Ink & Switch (highly recommended)
- [Yjs + IndexedDB](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb)
- [OPFS explainer](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
