# CRDTs & Yjs — The Core Problem and Solution

## The Problem: Concurrent Editing

Imagine two users, Alice and Bob, editing the same document simultaneously.
The document says: `"Hello"`

- Alice types " World" at the end → `"Hello World"`
- Bob types " There" at the end → `"Hello There"`

**Without conflict resolution**, whoever saves last wins, and the other person's
work is lost. This is the "last-write-wins" problem, and it's unacceptable for
a real-time editor.

## Two Solutions Exist

### 1. OT (Operational Transformation)
This is what Google Docs uses. The idea:
- Every edit is an **operation** (insert char 'X' at position 5)
- When two operations conflict, a **central server** transforms one relative
  to the other
- Example: If Alice inserts at position 5 and Bob inserts at position 3,
  Alice's position shifts to 6 because Bob's insert pushed everything right

**The problem with OT:**
- You NEED a central server to determine ordering
- The transformation logic is incredibly complex (Google spent years on it)
- Edge cases multiply with more concurrent users
- Hard to prove mathematically correct

### 2. CRDTs (Conflict-free Replicated Data Types)
This is what we're using (via Yjs). The idea:
- Instead of transforming operations, design the **data structure itself**
  so that it can be merged from any direction and always converge
- No central server needed for correctness
- Mathematically provable convergence

**The trade-off:** CRDTs use more memory (we'll learn why below).

---

## How Yjs Works Under the Hood

Yjs implements a specific CRDT algorithm called **YATA** (Yet Another
Transformation Approach). Here's how it works:

### Every Character Gets a Unique ID

When you type a character, Yjs assigns it a unique identifier:

```
ID = (clientID, clock)
```

- `clientID`: A random number assigned to your browser session. Every tab/device
  gets a different one.
- `clock`: A counter that starts at 0 and increments with every operation you
  make. Think of it as "this is the Nth thing I've done."

This pair is globally unique because no two clients share a clientID, and each
client's clock only goes up.

### Characters Form a Linked List

Each character knows which character comes before it (its "origin"):

```
Alice types "Hi":
  Item 1: { id: (Alice, 0), content: 'H', origin: null }      ← first char
  Item 2: { id: (Alice, 1), content: 'i', origin: (Alice, 0) } ← after 'H'
```

This is NOT like a normal array where position matters. Instead, each item
says "I go after THIS specific item." This is crucial because it means
the structure is independent of position.

### How Conflicts Are Resolved

When two users insert at the same position:

```
Document: "ab"

Alice inserts 'X' between a and b → { id: (Alice, 5), origin: a }
Bob inserts 'Y' between a and b   → { id: (Bob, 3), origin: a }
```

Both have the same origin ('a'), so there's a conflict. Yjs breaks the tie
using **clientID comparison**:
- If Alice's clientID < Bob's clientID → result is "aXYb"
- If Alice's clientID > Bob's clientID → result is "aYXb"

The key insight: **both Alice and Bob use the same comparison rule**, so they
BOTH arrive at the same result, independently, without talking to each other.

This is what "conflict-free" means — the data structure has a built-in,
deterministic rule for every possible conflict.

### Why "Tombstones" and Why More Memory

When you delete a character, Yjs does NOT remove it from the linked list.
Instead, it marks it as "deleted" (a tombstone). Why?

Think about it: if Alice deletes character X, and Bob (who hasn't received
that delete yet) inserts a new character right after X... Bob's new character
references X as its origin. If X were truly gone, Bob's insert would be
orphaned and we'd lose convergence.

So deleted items stay in memory forever (until garbage collected). This is
the main trade-off of CRDTs — over time, a heavily edited document accumulates
tombstones. For our project, we'll handle this with periodic snapshot
compaction (Phase 6).

---

## Yjs Data Types You'll Use

Yjs provides several CRDT types. Think of them like JavaScript's built-in
types, but conflict-free:

```typescript
import * as Y from 'yjs'

const doc = new Y.Doc()

// Y.Text — like a string, but collaborative
// NOT what Lexical uses directly (it uses XmlFragment)
const text = doc.getText('my-text')
text.insert(0, 'Hello')
text.delete(0, 2) // deletes 'He'

// Y.Map — like a JavaScript object/Map
// Great for metadata, settings, user state
const meta = doc.getMap('doc-meta')
meta.set('title', 'My Document')
meta.set('lastEditor', 'Alice')

// Y.Array — like a JavaScript array
// Good for ordered collections (comments, blocks)
const items = doc.getArray('items')
items.push(['first', 'second'])

// Y.XmlFragment — a tree of XML-like elements
// THIS is what Lexical uses under the hood via @lexical/yjs
// It maps Lexical's node tree to a CRDT tree structure
const xml = doc.getXmlFragment('editor-root')
```

### The Y.Doc — The Root Container

A `Y.Doc` is the root container for all shared data. Think of it like a
database:

```typescript
const doc = new Y.Doc()

// Each call to getText/getMap/etc creates a "shared type" within the doc.
// The string name ('editor', 'meta') is the key — like a table name.
// Any two clients using the same doc with the same key name will
// automatically stay in sync.
```

**Important mental model:** The Y.Doc is the **source of truth**. The Lexical
editor reads from it and writes to it. The WebSocket provider syncs it with
other clients. IndexedDB persists it locally. They're all just views/mirrors
of the same Y.Doc.

---

## How Syncing Works (The Protocol)

When two Yjs clients need to sync, they use a simple protocol:

### Step 1: Exchange State Vectors
A "state vector" is a compact summary of what a client has seen:

```
Alice's state vector: { Alice: 15, Bob: 7, Carol: 3 }
```

This means: "I have all of Alice's operations up to clock 15, all of Bob's
up to 7, and all of Carol's up to 3."

### Step 2: Send Missing Updates
Bob receives Alice's state vector and compares it to his own state. He can
see exactly what Alice is missing and sends only those operations.

```
Bob's state: { Alice: 15, Bob: 12, Carol: 3 }
Alice needs: Bob's operations 8-12 (she only has up to 7)
```

This is incredibly efficient — you never send data the other side already has.

### Step 3: Apply Updates
When Alice receives Bob's missing operations, she applies them to her Y.Doc.
The CRDT rules guarantee the result is the same regardless of the order
operations arrive.

---

## Key Takeaways

1. **CRDTs solve concurrent editing without a central authority** — every
   client can independently merge changes and arrive at the same result.

2. **Yjs uses unique IDs (clientID + clock) for every operation** — this
   ensures global uniqueness and deterministic ordering.

3. **Deletions are tombstones, not removals** — this preserves the reference
   chain that the CRDT needs for correctness.

4. **Syncing is delta-based using state vectors** — clients only exchange
   what the other is missing, making it very efficient even after being
   offline for a long time.

5. **The Y.Doc is the single source of truth** — the editor, persistence
   layer, and network layer are all just interfaces to the same Y.Doc.

---

## Further Reading

- [Yjs documentation](https://docs.yjs.dev/)
- [YATA algorithm paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types)
- [Martin Kleppmann's CRDT talk](https://www.youtube.com/watch?v=x7drE24geUw) — excellent intro
- [CRDTs: The Hard Parts](https://martin.kleppmann.com/2020/07/06/crdt-hard-parts-hydra.html)
