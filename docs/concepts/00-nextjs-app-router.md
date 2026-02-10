# Next.js App Router — Core Concepts for This Project

You know Next.js, but let's cement the App Router patterns that matter
specifically for a local-first collaborative editor.

## Server Components vs Client Components

This is the biggest mental shift in App Router. By default, every component
in the `app/` directory is a **Server Component**.

### Server Components (default)
- Run on the server at request time (or build time for static)
- Can directly access databases, file systems, environment variables
- Cannot use hooks (`useState`, `useEffect`, etc.)
- Cannot use browser APIs (`window`, `document`, `localStorage`)
- Cannot handle user interactions (onClick, onChange, etc.)
- Their code is NOT sent to the browser (smaller bundle)

### Client Components (`'use client'`)
- Run in the browser (also pre-render on server for initial HTML)
- CAN use hooks, browser APIs, event handlers
- Their code IS sent to the browser

### Why This Matters for Our Editor

The Lexical editor, Yjs, WebSocket provider — all of these are **client-only**.
They use browser APIs (DOM manipulation, WebSocket, IndexedDB). So our editor
components must be Client Components.

But the page that wraps the editor can be a Server Component:

```tsx
// src/app/doc/[id]/page.tsx — SERVER Component
// This runs on the server. It can fetch data, access the database, etc.

import { getDocument } from '@/lib/db/documents'
import { CollaborativeEditor } from '@/components/editor/CollaborativeEditor'

export default async function DocumentPage({
  params,
}: {
  params: { id: string }
}) {
  // This runs on the server — direct DB access, no API call needed
  const doc = await getDocument(params.id)

  if (!doc) {
    notFound()
  }

  // CollaborativeEditor is a Client Component ('use client')
  // We pass server-fetched data as props
  return (
    <main>
      <h1>{doc.title}</h1>
      <CollaborativeEditor
        documentId={doc.id}
        initialTitle={doc.title}
      />
    </main>
  )
}
```

```tsx
// src/components/editor/CollaborativeEditor.tsx — CLIENT Component
'use client'  // ← This directive makes it a Client Component

import { useState, useEffect, useMemo } from 'react'
import * as Y from 'yjs'
// ... all the Yjs/Lexical/WebSocket code

export function CollaborativeEditor({ documentId, initialTitle }) {
  // Hooks, browser APIs, event handlers — all fine here
  const [status, setStatus] = useState('connecting')
  // ...
}
```

**The pattern:** Server Components handle data fetching and layout. Client
Components handle interactivity. The boundary is the `'use client'` directive.

### The Serialization Boundary

When a Server Component passes props to a Client Component, those props
must be **serializable** (JSON-safe):

```tsx
// GOOD — strings, numbers, plain objects
<CollaborativeEditor
  documentId="abc123"        // string ✓
  initialTitle="My Doc"      // string ✓
  wordCount={5000}           // number ✓
/>

// BAD — functions, classes, Dates are not serializable
<CollaborativeEditor
  doc={new Y.Doc()}          // ✗ Class instance
  onSave={() => saveDoc()}   // ✗ Function
  createdAt={new Date()}     // ✗ Date object
/>
```

**For our project:** The server fetches document metadata (title, id, word
count) and passes it as serializable props. The Client Component creates the
Y.Doc and provider itself, since those are browser-only objects.

---

## Routing in App Router

### File-Based Routing

```
src/app/
├── layout.tsx          → Root layout (wraps everything)
├── page.tsx            → / (home page)
├── doc/
│   └── [id]/
│       ├── page.tsx    → /doc/abc123 (document editor)
│       └── loading.tsx → Loading UI while page.tsx fetches data
└── api/
    ├── documents/
    │   ├── route.ts    → GET/POST /api/documents
    │   └── [id]/
    │       └── route.ts → GET/PUT/DELETE /api/documents/abc123
    └── seed/
        └── route.ts    → POST /api/seed
```

### Dynamic Routes — `[id]`

The `[id]` folder creates a dynamic segment:

```tsx
// src/app/doc/[id]/page.tsx
export default async function DocPage({
  params
}: {
  params: { id: string }  // 'id' matches the folder name [id]
}) {
  // URL: /doc/abc123 → params.id = "abc123"
  const doc = await getDocument(params.id)
  return <CollaborativeEditor documentId={params.id} />
}
```

### Layouts — Persistent UI

Layouts wrap pages and persist across navigation:

```tsx
// src/app/layout.tsx — wraps ALL pages
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <nav>{/* Navigation — persists across page changes */}</nav>
        {children}  {/* This is where page.tsx renders */}
      </body>
    </html>
  )
}

// src/app/doc/[id]/layout.tsx — wraps only /doc/* pages (optional)
export default function DocLayout({ children }) {
  return (
    <div className="editor-layout">
      <Sidebar />      {/* Document sidebar — persists while editing */}
      <main>{children}</main>
    </div>
  )
}
```

**For our project:** The root layout has global styles and the nav bar.
The doc layout (optional) could have a sidebar with document list.

### loading.tsx — Instant Loading States

When a Server Component is fetching data, Next.js shows `loading.tsx`:

```tsx
// src/app/doc/[id]/loading.tsx
export default function Loading() {
  return (
    <div className="editor-skeleton">
      <div className="skeleton-toolbar" />
      <div className="skeleton-content" />
    </div>
  )
}
```

This shows immediately while `page.tsx`'s async data fetch completes.
Under the hood, Next.js uses React Suspense boundaries.

---

## Route Handlers (API Routes)

For our REST endpoints (document CRUD, seed endpoint):

```typescript
// src/app/api/documents/route.ts

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// GET /api/documents — list all documents
export async function GET() {
  const docs = await db.document.findMany({
    orderBy: { updatedAt: 'desc' },
  })
  return NextResponse.json(docs)
}

// POST /api/documents — create a new document
export async function POST(request: Request) {
  const body = await request.json()
  const doc = await db.document.create({
    data: { title: body.title, createdBy: body.userId },
  })
  return NextResponse.json(doc, { status: 201 })
}
```

```typescript
// src/app/api/documents/[id]/route.ts

// GET /api/documents/abc123 — get single document
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const doc = await db.document.findUnique({
    where: { id: params.id },
  })
  if (!doc) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(doc)
}
```

**Note:** Route handlers are for REST APIs (called by the client via fetch).
The WebSocket server is a separate process because Next.js route handlers
can't maintain persistent connections.

---

## Server Actions (Next.js 14+)

Server Actions are functions that run on the server but can be called from
Client Components. They're like API routes but without the boilerplate:

```typescript
// src/app/actions/documents.ts
'use server'  // ← This makes it a Server Action

import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'

export async function createDocument(title: string) {
  const doc = await db.document.create({
    data: { title, createdBy: 'current-user' },
  })

  revalidatePath('/') // Refresh the document list
  return doc
}

export async function deleteDocument(id: string) {
  await db.document.delete({ where: { id } })
  revalidatePath('/')
}
```

```tsx
// Client Component can call these directly
'use client'

import { createDocument } from '@/app/actions/documents'

function NewDocButton() {
  return (
    <button onClick={async () => {
      const doc = await createDocument('Untitled')
      // Navigate to the new document
      router.push(`/doc/${doc.id}`)
    }}>
      New Document
    </button>
  )
}
```

**For our project:** Server Actions are great for document CRUD (create,
rename, delete). The actual document content is handled by Yjs, not by
server actions.

---

## Caching and Revalidation

Next.js aggressively caches by default:

### fetch() in Server Components
```typescript
// Cached forever (static)
const data = await fetch('https://api.example.com/data')

// Revalidate every 60 seconds
const data = await fetch('https://api.example.com/data', {
  next: { revalidate: 60 }
})

// Never cache (always fresh)
const data = await fetch('https://api.example.com/data', {
  cache: 'no-store'
})
```

### revalidatePath / revalidateTag
```typescript
'use server'

// After creating a document, refresh the document list page
revalidatePath('/')

// Or revalidate a specific data tag
revalidateTag('documents')
```

**For our project:** The document list page can be cached and revalidated
when documents are created/deleted. The editor page itself fetches metadata
once (cached) and then everything else is handled by Yjs in the browser.

---

## The Custom Server Consideration

**Important:** Next.js App Router uses a Node.js server, but it doesn't
support WebSocket upgrade out of the box. For our WebSocket server, we have
two options:

### Option 1: Separate WebSocket Server (Recommended)
```
Next.js (port 3000) — handles HTTP, SSR, API routes
WebSocket Server (port 3001) — handles real-time sync
```

Simpler to deploy, easier to scale independently.

### Option 2: Custom Next.js Server
```typescript
// server/index.ts
import { createServer } from 'http'
import next from 'next'
import { WebSocketServer } from 'ws'

const app = next({ dev: process.env.NODE_ENV !== 'production' })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res))

  const wss = new WebSocketServer({ server })
  wss.on('connection', handleWebSocket)

  server.listen(3000)
})
```

Runs on one port, but harder to deploy (Vercel doesn't support custom
servers) and harder to scale.

**We'll use Option 1** — separate processes. It's the production-ready
approach and easier to reason about.

---

## Environment Variables

Next.js has specific rules for env vars:

```
# .env.local (not committed to git)

# Server-only (accessible in Server Components, Route Handlers, Server Actions)
DATABASE_URL=postgresql://localhost:5432/collab-editor
REDIS_URL=redis://localhost:6379

# Client-accessible (MUST start with NEXT_PUBLIC_)
NEXT_PUBLIC_WS_URL=ws://localhost:3001
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**The `NEXT_PUBLIC_` prefix** is required for any env var used in Client
Components. Without it, the variable is undefined in the browser (for
security — you don't want database URLs in client bundles).

---

## Key Takeaways

1. **Server Components for data, Client Components for interactivity.**
   The editor is a Client Component. The page wrapper is a Server Component
   that fetches initial data.

2. **The serialization boundary** between server and client means you can
   only pass JSON-safe props to Client Components. Create Y.Docs and
   providers inside Client Components.

3. **Route handlers for REST APIs, Server Actions for mutations.** Use
   route handlers for the seed endpoint and document snapshots. Use server
   actions for simple CRUD.

4. **The WebSocket server is separate from Next.js.** Next.js handles
   HTTP; a standalone Node.js process handles WebSocket connections.

5. **`NEXT_PUBLIC_` prefix** for any env var used in client code.

6. **Layouts persist across navigation.** Put global UI (nav, sidebar)
   in layouts so they don't unmount when navigating between documents.
