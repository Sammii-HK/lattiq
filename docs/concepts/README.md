# Concept Guides — Lattiq Collaborative Editor

These guides explain the core technologies and concepts behind the project.
Read them in order, or jump to what you need.

## Foundations (solidify what you know)
- **[00 - React Core Concepts](./00-react-core-concepts.md)** — Render cycle, hooks mental models, performance patterns for real-time apps
- **[00 - Next.js App Router](./00-nextjs-app-router.md)** — Server vs Client Components, routing, why the WebSocket server is separate

## New Concepts (the interesting stuff)
- **[01 - CRDTs & Yjs](./01-crdts-and-yjs.md)** — How conflict-free data types work, Yjs internals, why tombstones exist
- **[02 - Lexical Editor](./02-lexical-editor.md)** — Meta's editor framework, node tree model, plugin architecture, @lexical/yjs bridge
- **[03 - Local-First Architecture](./03-local-first-architecture.md)** — The philosophy, initialization order, persistence layers, sync state machine
- **[04 - WebSockets & Sync Protocol](./04-websockets-and-sync.md)** — Binary protocol, state vectors, awareness, reconnection strategy

## Reading Order for Maximum Understanding

If you're reading all of them:

1. Start with **01 - CRDTs & Yjs** — this is the theoretical foundation
2. Then **03 - Local-First Architecture** — how we apply CRDTs in practice
3. Then **04 - WebSockets & Sync** — how the data moves between clients
4. Then **02 - Lexical Editor** — the user-facing layer on top of all this
5. Refer back to **00 - React** and **00 - Next.js** as needed during implementation
