# Lexical — Meta's Editor Framework

## Why Lexical (and Not Slate, ProseMirror, or Quill)?

There are several rich text editor frameworks. Here's why Lexical fits this
project:

| Framework    | Who         | Model       | CRDT Support                    |
|-------------|-------------|-------------|----------------------------------|
| Quill       | Slab        | Delta-based | Has Yjs binding, but limited     |
| Slate       | Community   | JSON tree   | No official Yjs binding          |
| ProseMirror | Marijn H.   | Schema tree | Has Yjs binding, complex API     |
| Lexical     | Meta (FB)   | Node tree   | Official `@lexical/yjs` binding  |

Lexical wins because:
1. **Official Yjs binding** (`@lexical/yjs`) — maintained by the same team
2. **Tree-based model** maps naturally to Yjs's `XmlFragment` CRDT type
3. **Extensible via plugins** — add functionality without modifying core
4. **Framework-agnostic core** with React bindings — fits Next.js perfectly
5. **Actively maintained** by Meta — used in Facebook, Instagram, Threads

## Lexical's Mental Model

### The Editor State

Lexical maintains an **immutable editor state** — a tree of nodes:

```
EditorState (root)
└── RootNode
    ├── ParagraphNode
    │   └── TextNode("Hello ")
    │   └── TextNode("world", { bold: true })
    ├── HeadingNode (h2)
    │   └── TextNode("Chapter 1")
    └── ParagraphNode
        └── TextNode("Some content...")
```

This is conceptually similar to the DOM, but it's Lexical's own tree — NOT
the actual DOM. Lexical reconciles its tree with the DOM, similar to how
React reconciles its virtual DOM.

### Node Types

Lexical has a hierarchy of node types:

```
                    LexicalNode (base)
                    /          \
            ElementNode      DecoratorNode
           /    |    \          (for embeds,
    ParagraphNode  HeadingNode   custom components)
    ListNode       QuoteNode
    ...

    TextNode (leaf — contains actual text content)
```

- **ElementNode**: Can have children (paragraphs, headings, lists)
- **TextNode**: Leaf nodes that hold text + formatting (bold, italic, etc.)
- **DecoratorNode**: For non-text content (images, embeds, code blocks)

You register which node types your editor supports in the config:

```typescript
const config = {
  namespace: 'MyEditor',
  nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
  // Only these node types can exist in the editor
}
```

### Updates Happen in "Transactions"

You never modify the editor state directly. Instead, you dispatch updates:

```typescript
editor.update(() => {
  // Inside this callback, you can read and write the editor state.
  // Lexical batches all changes and applies them atomically.

  const root = $getRoot()
  const paragraph = $createParagraphNode()
  const text = $createTextNode('Hello')
  paragraph.append(text)
  root.append(paragraph)
})
```

The `$` prefix on functions (`$getRoot`, `$createTextNode`) is a Lexical
convention. These functions can ONLY be called inside an `editor.update()`
or `editor.read()` callback. If you call them outside, you'll get an error.

Think of it like a database transaction — you read and write inside a
transaction, and it's committed atomically.

### The Plugin Architecture

Lexical's killer feature is its plugin system. The core editor does very
little on its own — plugins add all the functionality:

```tsx
<LexicalComposer initialConfig={config}>
  {/* Core editing surface */}
  <RichTextPlugin
    contentEditable={<ContentEditable />}
    placeholder={<div>Start typing...</div>}
  />

  {/* Undo/redo */}
  <HistoryPlugin />

  {/* Real-time collaboration via Yjs */}
  <CollaborationPlugin
    id="doc-123"
    providerFactory={createProvider}
  />

  {/* Your custom plugins */}
  <ToolbarPlugin />
  <CursorPlugin />
</LexicalComposer>
```

Each plugin is a React component that registers listeners and commands with
the editor. This is how you'll add features like:
- Toolbar (listens for selection changes, dispatches format commands)
- Collaboration (bridges Lexical ↔ Yjs)
- Cursor overlay (reads awareness state, renders colored cursors)

---

## How @lexical/yjs Bridges the Two Worlds

This is the most important piece to understand for our project. The
`@lexical/yjs` package creates a **two-way binding** between Lexical's
node tree and a Yjs `XmlFragment`:

```
Lexical Node Tree              Yjs XmlFragment (CRDT)
─────────────────              ─────────────────────
RootNode            ←─────►   Y.XmlFragment('root')
├── ParagraphNode   ←─────►   Y.XmlElement('paragraph')
│   └── TextNode    ←─────►   Y.XmlText
├── HeadingNode     ←─────►   Y.XmlElement('heading')
│   └── TextNode    ←─────►   Y.XmlText
```

**When you type in the editor:**
1. Lexical creates the update in its node tree
2. `@lexical/yjs` converts it to a Yjs operation on the XmlFragment
3. Yjs propagates the change through its update mechanism
4. The WebSocket provider sends it to other clients

**When a remote update arrives:**
1. WebSocket provider applies the Yjs update to the local Y.Doc
2. The Y.Doc's XmlFragment changes
3. `@lexical/yjs` detects the change and updates Lexical's node tree
4. Lexical reconciles with the DOM — you see the change

This means **you don't write sync code yourself** — the binding handles it.
Your job is to:
1. Set up the Y.Doc and provider correctly
2. Pass them to `CollaborationPlugin`
3. Handle the UI around it (status, cursors, etc.)

---

## Key Lexical Concepts You'll Use

### Selections

Lexical tracks the user's cursor/selection:

```typescript
editor.update(() => {
  const selection = $getSelection()

  if ($isRangeSelection(selection)) {
    // User has a cursor or text selected
    selection.anchor // { key: nodeKey, offset: number }
    selection.focus  // { key: nodeKey, offset: number }
  }
})
```

For collaboration, the selection is sent to other clients via Yjs awareness
(so they can see your cursor).

### Commands & Listeners

Lexical uses a command/listener pattern:

```typescript
// Register a command handler
editor.registerCommand(
  FORMAT_TEXT_COMMAND,
  (formatType) => {
    // Handle the command
    const selection = $getSelection()
    if ($isRangeSelection(selection)) {
      selection.formatText(formatType)
    }
    return true // command handled
  },
  COMMAND_PRIORITY_NORMAL
)

// Dispatch a command (e.g., from a toolbar button)
editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')
```

### Transforms

Transforms let you react to changes in the editor state:

```typescript
// Whenever a TextNode changes, do something
editor.registerNodeTransform(TextNode, (node) => {
  // e.g., auto-capitalize first letter of sentences
  // e.g., detect and linkify URLs
})
```

---

## Key Takeaways

1. **Lexical is a tree of nodes**, not a flat string. This maps naturally
   to Yjs's XmlFragment CRDT type.

2. **@lexical/yjs does the heavy lifting** — it bridges Lexical's node
   tree to the Yjs CRDT. You don't write sync logic manually.

3. **Plugins are how you add features** — toolbar, collaboration, cursors,
   and anything custom are all plugins.

4. **Updates are transactions** — you read/write inside `editor.update()`
   callbacks, never directly.

5. **The `$` prefix functions** can only be called inside update/read
   callbacks — this is enforced at runtime.

---

## Further Reading

- [Lexical documentation](https://lexical.dev/)
- [Lexical playground](https://playground.lexical.dev/) — great for seeing
  what's possible
- [@lexical/yjs source](https://github.com/facebook/lexical/tree/main/packages/lexical-yjs)
