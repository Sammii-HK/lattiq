# React — Core Concepts Made Concrete

You know React, but let's make the mental models concrete — especially the
parts that matter most for this collaborative editor project.

## The Render Cycle — What Actually Happens

When people say "React re-renders," here's what's actually going on:

```
1. Something triggers a render:
   - setState() called
   - Parent re-renders (and passes new props)
   - Context value changes
   - useSyncExternalStore detects external change

2. React calls your component function again
   - ALL the code in the function body runs
   - Hooks execute in order
   - A new JSX tree (virtual DOM) is returned

3. React "reconciles" — diffs old tree vs new tree
   - Same element type at same position? Update its props/attributes
   - Different type? Destroy old, create new
   - Key changed? Destroy old, create new (even if same type)

4. React commits — applies the minimal DOM changes
   - Only the actual differences touch the real DOM
   - This is why React is fast despite re-running your whole function
```

**Key insight for our project:** When Yjs fires an update (another user typed
something), it triggers a state change that causes a re-render. Lexical
handles this efficiently because it has its own reconciliation (it doesn't
re-render the entire editor — just the changed nodes). But any React state
we manage outside Lexical (like the active users list, sync status) WILL
cause re-renders, so we need to be thoughtful.

---

## Hooks — The Mental Model

Hooks aren't magic. They're entries in an array that React maintains per
component instance:

```
Component: CollaborativeEditor

Hooks array (maintained by React):
  [0] useState('connecting')     → status
  [1] useState(false)            → synced
  [2] useState(new Map())        → activeUsers
  [3] useMemo(() => {...})       → { doc, provider }
  [4] useEffect(() => {...})     → awareness setup
```

**Why hooks must be called in the same order every render:** React identifies
hooks by their position in this array. If you put a hook inside an `if`
statement, the array positions shift and React assigns the wrong state to
the wrong hook. This is why the "rules of hooks" exist.

### useState — When to Use It

```typescript
const [status, setStatus] = useState<string>('connecting')
```

Use for values that:
- The UI displays directly
- When changed, should trigger a re-render

**Don't use for:** values that change frequently but don't need to update
the UI on every change. For example, the pending updates buffer in our
WebSocket provider changes on every keystroke, but we don't show it in the
UI — so it's a class property, not React state.

### useRef — When to Use It

```typescript
const wsRef = useRef<WebSocket | null>(null)
```

Use for values that:
- Need to persist across renders (like useState)
- Should NOT trigger a re-render when changed (unlike useState)
- Need to be mutable (unlike useState, which you should treat as immutable)

**In our project:** We use refs for WebSocket instances, timers, and the
Yjs provider — things we need to access but don't render directly.

### useMemo — Expensive Computations and Stable References

```typescript
const { doc, provider } = useMemo(() => {
  const doc = new Y.Doc()
  const provider = new CollaborationProvider(wsUrl, roomName, doc)
  return { doc, provider }
}, [documentId])
```

**What it does:** Caches the return value. Only recomputes when dependencies
change.

**In our project:** Creating a Y.Doc and WebSocket provider is expensive
and should only happen once per document. `useMemo` with `[documentId]` as
the dependency ensures we create new instances only when the document changes.

**Warning:** `useMemo` is for performance optimization, not for guaranteeing
something runs only once. React may throw away the cached value and
recompute. For truly one-time setup, `useEffect` with cleanup is better.

### useEffect — Side Effects and Cleanup

```typescript
useEffect(() => {
  // Setup: runs after render
  provider.awareness.setLocalStateField('user', { name, color })

  const unsubStatus = provider.onStatus(setStatus)
  const unsubSync = provider.onSync(setSynced)

  // Cleanup: runs before next effect or unmount
  return () => {
    unsubStatus()
    unsubSync()
    provider.destroy()
  }
}, [provider]) // Only re-run when provider changes
```

**The mental model:** Effects are for synchronizing React with external
systems. Our Yjs provider is an external system — it lives outside React's
render cycle. The effect connects React to it (subscriptions, listeners)
and cleans up when done.

**Common mistake in our domain:** Forgetting cleanup. If you subscribe to
awareness changes but don't unsubscribe on unmount, you'll get memory
leaks and "setState on unmounted component" warnings.

### useCallback — Stable Function References

```typescript
const handleAwarenessChange = useCallback(() => {
  setActiveUsers(new Map(provider.awareness.getStates()))
}, [provider])
```

**Why it matters:** Without `useCallback`, this function is recreated every
render. If you pass it as a prop to a child component or as a dependency
to another hook, it'll cause unnecessary re-renders/re-runs.

**Rule of thumb:** Use `useCallback` for functions that are:
- Passed as props to memoized child components
- Used as dependencies in useEffect/useMemo
- Event handlers registered on external systems (like Yjs awareness)

---

## Component Patterns You'll Use

### The Provider Pattern (Context + Provider)

We'll wrap the editor in context providers for shared state:

```tsx
// Yjs collaboration context
const CollabContext = createContext<{
  doc: Y.Doc
  provider: CollaborationProvider
  awareness: awarenessProtocol.Awareness
} | null>(null)

function CollabProvider({ documentId, children }) {
  const value = useMemo(() => {
    const doc = new Y.Doc()
    const provider = new CollaborationProvider(wsUrl, `doc-${documentId}`, doc)
    return { doc, provider, awareness: provider.awareness }
  }, [documentId])

  useEffect(() => {
    return () => {
      value.provider.destroy()
      value.doc.destroy()
    }
  }, [value])

  return (
    <CollabContext.Provider value={value}>
      {children}
    </CollabContext.Provider>
  )
}

// Custom hook to consume the context
function useCollab() {
  const ctx = useContext(CollabContext)
  if (!ctx) throw new Error('useCollab must be used within CollabProvider')
  return ctx
}
```

**Why:** Multiple components need access to the same Y.Doc and provider
(the editor, the toolbar, the cursor overlay, the status bar). Context
gives them all access without prop drilling.

### Custom Hooks for Clean Separation

```typescript
// usePresence.ts — encapsulates all awareness logic
function usePresence() {
  const { awareness } = useCollab()
  const [users, setUsers] = useState<Map<number, UserState>>(new Map())

  useEffect(() => {
    const onChange = () => {
      setUsers(new Map(awareness.getStates()))
    }
    awareness.on('change', onChange)
    return () => awareness.off('change', onChange)
  }, [awareness])

  return users
}

// Usage in any component:
function ActiveUsers() {
  const users = usePresence()
  return <div>{/* render user avatars */}</div>
}
```

**The pattern:** Each custom hook encapsulates one concern (presence, sync
status, reconnection). Components consume hooks and focus purely on rendering.

---

## Performance Patterns That Matter for This Project

### 1. Avoiding Unnecessary Re-renders

When Yjs fires updates, we need to be careful about what triggers re-renders:

```typescript
// BAD — creates new object every render, causes children to re-render
function Editor() {
  const stats = {
    syncLatency: provider.getLatency(),
    docSize: provider.getDocSize(),
  }
  return <MetricsPanel stats={stats} />
}

// GOOD — memoize the object
function Editor() {
  const stats = useMemo(() => ({
    syncLatency: provider.getLatency(),
    docSize: provider.getDocSize(),
  }), [latency, docSize])
  return <MetricsPanel stats={stats} />
}
```

### 2. Splitting State to Minimize Blast Radius

```typescript
// BAD — changing sync status re-renders everything that uses this state
const [editorState, setEditorState] = useState({
  status: 'connecting',
  synced: false,
  activeUsers: new Map(),
  documentTitle: '',
})

// GOOD — each piece of state is independent
const [status, setStatus] = useState('connecting')
const [synced, setSynced] = useState(false)
const [activeUsers, setActiveUsers] = useState(new Map())
const [documentTitle, setDocumentTitle] = useState('')
// Now changing status doesn't re-render components that only care about title
```

### 3. Using Zustand for State Outside React

For state that multiple unrelated components need, and that changes
frequently (like collaboration metrics), Zustand is lighter than Context:

```typescript
import { create } from 'zustand'

const useEditorStore = create((set) => ({
  syncStatus: 'disconnected',
  activeUsers: [],
  metrics: { latency: 0, docSize: 0 },

  setSyncStatus: (status) => set({ syncStatus: status }),
  setActiveUsers: (users) => set({ activeUsers: users }),
  updateMetrics: (metrics) => set({ metrics }),
}))

// Any component can subscribe to just the slice it needs:
function StatusBar() {
  const status = useEditorStore((s) => s.syncStatus)
  // Only re-renders when syncStatus changes, not when metrics change
  return <div>{status}</div>
}
```

---

## React Strict Mode — Why You See Double Effects

In development, React Strict Mode (enabled by default in Next.js) runs
effects twice:

```
Mount → Effect runs → Cleanup runs → Effect runs again
```

This catches bugs where you forgot cleanup. For our project, this means
the WebSocket provider might connect, disconnect, and reconnect on mount
in development. This is expected — it won't happen in production.

---

## Key Takeaways

1. **Re-renders are cheap; DOM updates are expensive.** React's reconciler
   ensures only necessary DOM changes happen. Don't over-optimize.

2. **Separate React state from external system state.** The Y.Doc and
   WebSocket provider live outside React. Use effects to sync them.

3. **Split state granularly.** Each piece of state should trigger re-renders
   only in components that display it.

4. **Custom hooks encapsulate concerns.** One hook per concept (presence,
   sync status, reconnection) keeps components clean.

5. **useRef for mutable, non-rendering values.** WebSocket instances,
   timers, and Yjs docs are refs, not state.

6. **Zustand for cross-cutting state.** When multiple unrelated components
   need the same data, Zustand is lighter than Context for frequently
   changing values.
