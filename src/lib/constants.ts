/**
 * constants.ts — Document catalogue for the Lattiq editor.
 *
 * This is the single source of truth for all documents shown in the
 * document list UI. Each entry has:
 *   - id: Used in URL routing (/doc/{id}) and as the Yjs room name
 *         prefix (the room name is "doc-{id}", see useCollaboration.ts)
 *   - title: Displayed in the document list
 *   - description: Short summary shown below the title
 *
 * ## Two kinds of documents
 *
 * 1. **Stub documents**: The original 4 documents that start empty.
 *    Users create content from scratch. These are great for testing
 *    real-time collaboration (open two browser tabs, type in both).
 *
 * 2. **Seeded Gutenberg books**: Pre-populated with real public domain
 *    literature. Created by running POST /api/seed, which downloads
 *    books from Project Gutenberg and converts them to Yjs documents.
 *    These are great for testing editing, scrolling, and load performance
 *    with real-world content at various sizes.
 *
 * The document IDs for seeded books MUST match the docId values in
 * src/lib/seed/seed-documents.ts — that's how the seeder knows what
 * file names to write, and how the editor knows what room to join.
 */

export interface Document {
  id: string;
  title: string;
  description: string;
}

export const DOCUMENTS: Document[] = [
  // ── Stub documents (start empty, user creates content) ──────────
  {
    id: "getting-started",
    title: "Getting Started",
    description: "Welcome to Lattiq, your local-first collaborative editor.",
  },
  {
    id: "meeting-notes",
    title: "Meeting Notes",
    description: "Weekly team sync and action items.",
  },
  {
    id: "project-roadmap",
    title: "Project Roadmap",
    description: "Milestones, goals, and feature planning.",
  },
  {
    id: "scratch-pad",
    title: "Scratch Pad",
    description: "Quick notes and ideas. Throw anything here.",
  },

  // ── Seeded Gutenberg books (run POST /api/seed to populate) ─────
  //
  // These entries appear in the document list immediately, but the
  // documents will be empty until you run the seed endpoint. After
  // seeding, they contain full book text with headings and paragraphs.
  //
  // The IDs here match the docId values in seed-documents.ts.
  {
    id: "the-yellow-wallpaper",
    title: "The Yellow Wallpaper",
    description:
      "Charlotte Perkins Gilman's short story (~6K words). Quick editing demo.",
  },
  {
    id: "alice-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    description:
      "Lewis Carroll's classic (~27K words). A typical document size.",
  },
  {
    id: "pride-and-prejudice",
    title: "Pride and Prejudice",
    description:
      "Jane Austen's novel (~122K words). Stress test for large documents.",
  },
];

export function getDocumentById(id: string): Document | undefined {
  return DOCUMENTS.find((doc) => doc.id === id);
}
