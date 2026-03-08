# Lattiq

A local-first collaborative rich text editor built with Next.js, Lexical, and Yjs.

![Lattiq editor screenshot](docs/screenshot.png)

## What it does

Lattiq is a rich text editor where your content lives in the browser first. Changes are saved to IndexedDB automatically with no account or cloud dependency. When a WebSocket collaboration server is running, edits sync in real time between connected clients using CRDTs (Conflict-free Replicated Data Types).

## Features

- **Local-first persistence** — content saves to IndexedDB instantly, works offline, loads without a server
- **Rich text editing** — headings, bold, italic, underline, bullet/numbered lists, code blocks, block quotes, links
- **Real-time collaboration** — WebSocket server with Yjs CRDT sync, cursor presence, and active user indicators
- **Gutenberg book seeding** — pre-populated with public domain literature at various sizes for testing editor performance
- **Formatting toolbar** — visual toolbar with keyboard shortcut support

## Tech stack

- **Framework**: Next.js 15 (App Router)
- **Editor**: Lexical (Meta's extensible text editor)
- **CRDTs**: Yjs with y-indexeddb for local persistence
- **Sync**: Custom WebSocket server with room management and file-based persistence
- **Styling**: Tailwind CSS
- **Language**: TypeScript

## Architecture

```
Browser                          Server
┌─────────────────────┐         ┌──────────────────┐
│  Lexical Editor      │         │  WebSocket Server │
│  ┌───────────────┐   │   WS   │  ┌─────────────┐  │
│  │ CollabPlugin   │◄─┼────────┼─►│ Room Manager │  │
│  └───────┬───────┘   │         │  └──────┬──────┘  │
│          │           │         │         │         │
│  ┌───────▼───────┐   │         │  ┌──────▼──────┐  │
│  │   Y.Doc       │   │         │  │  .yjs files │  │
│  └───────┬───────┘   │         │  └─────────────┘  │
│          │           │         └──────────────────┘
│  ┌───────▼───────┐   │
│  │  IndexedDB    │   │
│  └───────────────┘   │
└─────────────────────┘
```

Content flows through Yjs CRDTs. Every edit becomes a Yjs operation that is:
1. Applied to the in-memory Y.Doc immediately
2. Persisted to IndexedDB in the background
3. Sent to the WebSocket server (if connected)
4. Relayed to other connected clients

## Getting started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the document list.

### Seed Gutenberg books

To populate the editor with public domain literature:

```bash
curl -X POST http://localhost:3000/api/seed
```

This downloads three books from Project Gutenberg at different sizes:
- **The Yellow Wallpaper** (~6K words) — quick editing demo
- **Alice's Adventures in Wonderland** (~27K words) — typical document size
- **Pride and Prejudice** (~122K words) — large document stress test

### Start the collaboration server

```bash
pnpm dev:ws
```

This starts the WebSocket server on port 3001. Open the same document in two browser tabs to see real-time sync.

## Project structure

```
src/
  app/                          # Next.js App Router pages
    doc/[id]/                   # Document editor page
    api/seed/                   # Gutenberg book seeder endpoint
    api/doc/[id]/content/       # Server-side content extraction
  components/editor/            # Lexical editor components
    CollaborativeEditor.tsx     # Main editor with plugin composition
    ToolbarPlugin.tsx           # Formatting toolbar
    LoadContentPlugin.tsx       # Fetches seeded content from server
  hooks/
    useCollaboration.ts         # Y.Doc lifecycle + WebSocket provider
  lib/
    yjs/
      collaboration-provider.ts # Custom WebSocket provider for Yjs
      local-provider.ts         # Offline fallback provider
    seed/
      gutenberg.ts              # Gutenberg API client
      text-to-yjs.ts            # Plain text to Yjs document converter
      seed-documents.ts         # Seed orchestrator
    initial-content.ts          # Welcome content for Getting Started doc
    constants.ts                # Document catalogue
server/
  index.ts                      # Standalone WebSocket collaboration server
```

## Learning project

This codebase is thoroughly commented as a reference for understanding:
- How Lexical's plugin architecture works
- How Yjs CRDTs represent document state
- How the Yjs sync protocol exchanges updates between peers
- How local-first architecture prioritises offline capability
- How WebSocket rooms manage per-document collaboration

## Licence

MIT
