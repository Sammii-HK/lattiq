/**
 * seed-documents.ts — Orchestrator that fetches Gutenberg books and
 * persists them as Yjs binary files.
 *
 * ## What this does
 *
 * 1. Downloads a curated list of public domain books from Project Gutenberg
 * 2. Converts each book's plain text into a Y.Doc (matching Lexical's
 *    internal Yjs structure)
 * 3. Encodes each Y.Doc as a binary update (Uint8Array)
 * 4. Saves the binary files to `.lattiq-data/` where the WebSocket server
 *    will find them on next client connection
 *
 * ## Why these specific books?
 *
 * We chose three books at very different sizes to demonstrate different
 * aspects of collaborative editing:
 *
 * - **The Yellow Wallpaper** (~6K words): A short story. Loads instantly,
 *   great for quick editing demos and testing formatting features.
 *
 * - **Alice's Adventures in Wonderland** (~27K words): A medium novel.
 *   Represents typical document sizes you'd see in real collaborative
 *   work (meeting notes, project specs, etc.).
 *
 * - **Pride and Prejudice** (~122K words): A full novel. Tests how well
 *   the editor handles large documents — Yjs CRDT performance, scroll
 *   rendering, initial sync time, etc.
 *
 * ## File naming convention
 *
 * The WebSocket server (server/index.ts) persists documents as:
 *   `.lattiq-data/{roomName}.yjs`
 *
 * The client connects to rooms named `doc-{docId}` (see useCollaboration.ts
 * line 158: `doc-${docId}`).
 *
 * So for a document with id "alice-in-wonderland":
 *   - Room name: "doc-alice-in-wonderland"
 *   - File path: ".lattiq-data/doc-alice-in-wonderland.yjs"
 *
 * The IDs we use here MUST match the entries we add to constants.ts.
 */

import * as fs from "fs";
import * as path from "path";
import * as Y from "yjs";
import { fetchGutenbergBook } from "./gutenberg";
import { textToYDoc } from "./text-to-yjs";

// ── Book catalogue ─────────────────────────────────────────────────

/**
 * A book to seed into the editor.
 *
 * We store both the Gutenberg ID (for downloading) and our own document
 * ID (for the file system and URL routing). The description appears on
 * the document list page.
 */
interface SeedBook {
  /** Our internal document ID — used in URLs and file names */
  docId: string;
  /** Project Gutenberg catalogue ID */
  gutenbergId: number;
  /** Description shown in the document list */
  description: string;
}

/**
 * Curated list of books to seed.
 *
 * These are chosen for variety in length and content type. All are
 * well-known public domain works that are reliably available on Gutenberg.
 *
 * The docId values here MUST match the entries in src/lib/constants.ts.
 */
const SEED_BOOKS: SeedBook[] = [
  {
    docId: "the-yellow-wallpaper",
    gutenbergId: 1952,
    description:
      "Charlotte Perkins Gilman's short story (~6K words). Quick editing demo.",
  },
  {
    docId: "alice-in-wonderland",
    gutenbergId: 11,
    description:
      "Lewis Carroll's classic (~27K words). A typical document size.",
  },
  {
    docId: "pride-and-prejudice",
    gutenbergId: 1342,
    description:
      "Jane Austen's novel (~122K words). Stress test for large documents.",
  },
];

// ── Data directory ─────────────────────────────────────────────────

/**
 * Path to the data directory where Yjs binary files are stored.
 *
 * This is the same directory used by the WebSocket server (server/index.ts).
 * We use process.cwd() to resolve relative to the project root, which
 * works whether we're called from a Next.js API route or a CLI script.
 */
const DATA_DIR = path.join(process.cwd(), ".lattiq-data");

/**
 * Ensure the data directory exists.
 *
 * Uses recursive: true so it works even if parent directories are missing
 * (shouldn't happen, but defensive programming costs nothing here).
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ── Seed result type ───────────────────────────────────────────────

/**
 * Result of seeding a single book.
 *
 * Returned to the caller so they can report what happened — especially
 * useful in the API route to show success/failure for each book.
 */
export interface SeedResult {
  /** Our internal document ID */
  docId: string;
  /** The book title (from Gutenberg metadata) */
  title: string;
  /** Author name (formatted as "First Last") */
  author: string;
  /** Whether this book was successfully seeded */
  success: boolean;
  /** Error message if seeding failed */
  error?: string;
  /** File size of the persisted .yjs file in bytes */
  fileSize?: number;
  /** Number of text blocks (paragraphs + headings) parsed */
  blockCount?: number;
}

// ── Seed functions ─────────────────────────────────────────────────

/**
 * Seed a single book: download, convert, and persist.
 *
 * This is the core pipeline for one book:
 *   1. Fetch from Gutenberg (HTTP requests to gutendex.com + gutenberg.org)
 *   2. Parse + convert to Y.Doc (in-memory text processing)
 *   3. Encode Y.Doc to binary (Yjs serialisation)
 *   4. Write binary to disk (file I/O)
 *
 * Each step can fail independently. We catch errors and return a result
 * object rather than throwing — this lets seedDocuments() continue with
 * the other books even if one fails.
 *
 * @param book - The book to seed
 * @returns A SeedResult describing what happened
 */
async function seedBook(book: SeedBook): Promise<SeedResult> {
  try {
    console.log(`Fetching "${book.docId}" (Gutenberg #${book.gutenbergId})...`);

    // Step 1: Download the book from Gutenberg
    const { title, author, text } = await fetchGutenbergBook(
      book.gutenbergId
    );
    console.log(
      `  Downloaded "${title}" by ${author} (${text.length} characters)`
    );

    // Step 2: Convert plain text to a Y.Doc
    // textToYDoc handles parsing (splitting into paragraphs/headings)
    // and Yjs construction (creating the XmlText tree that Lexical expects)
    const doc = textToYDoc(text);

    // Count blocks for reporting. We read the root XmlText's delta to
    // count how many element nodes were created.
    const root = doc.get("root", Y.XmlText);
    const delta = root.toDelta();
    const blockCount = delta.length;
    console.log(`  Parsed into ${blockCount} blocks`);

    // Step 3: Encode the Y.Doc as a binary update.
    // encodeStateAsUpdate() produces a compact binary representation of
    // the entire document state. This is the same format the WebSocket
    // server uses for persistence (see server/index.ts saveDocument()).
    const update = Y.encodeStateAsUpdate(doc);

    // Step 4: Write to disk.
    // The file name follows the convention: doc-{docId}.yjs
    // This matches the room name format in useCollaboration.ts.
    const roomName = `doc-${book.docId}`;
    const filePath = path.join(DATA_DIR, `${roomName}.yjs`);
    fs.writeFileSync(filePath, update);

    const fileSize = update.length;
    console.log(
      `  Saved to ${filePath} (${(fileSize / 1024).toFixed(1)} KB)`
    );

    // Clean up the Y.Doc to free memory.
    // We don't need it anymore — the binary file has the full state.
    doc.destroy();

    return {
      docId: book.docId,
      title,
      author,
      success: true,
      fileSize,
      blockCount,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`  Failed to seed "${book.docId}": ${message}`);

    return {
      docId: book.docId,
      title: "Unknown",
      author: "Unknown",
      success: false,
      error: message,
    };
  }
}

/**
 * Seed all curated Gutenberg books.
 *
 * Downloads and converts each book sequentially (not in parallel) to be
 * kind to Gutenberg's servers. They're a volunteer-run project and we
 * don't want to hammer them with concurrent requests.
 *
 * ## Idempotency
 *
 * Running this multiple times is safe — it overwrites existing .yjs files.
 * However, this means any edits made to seeded documents will be lost.
 * That's fine for development — these are demo documents, not user data.
 *
 * In a real app, you'd check if the file already exists and skip it.
 * But for a learning project, always re-seeding ensures a clean state.
 *
 * @returns Array of SeedResults, one per book
 */
export async function seedDocuments(): Promise<SeedResult[]> {
  ensureDataDir();

  console.log("=== Seeding Gutenberg books ===\n");
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Books to seed: ${SEED_BOOKS.length}\n`);

  const results: SeedResult[] = [];

  // Process books sequentially to avoid hammering Gutenberg's servers.
  // We could use Promise.all for parallelism, but there's no rush —
  // seeding only happens once, and being a good API citizen matters.
  for (const book of SEED_BOOKS) {
    const result = await seedBook(book);
    results.push(result);
    console.log(""); // Blank line between books for readability
  }

  // Summary
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log("=== Seeding complete ===");
  console.log(
    `  ${succeeded} succeeded, ${failed} failed, ${results.length} total`
  );

  return results;
}

/**
 * Export the book catalogue so other modules (like constants.ts) can
 * reference the same document IDs and descriptions.
 *
 * This avoids hardcoding the same IDs in two places, which would be
 * a maintenance hazard.
 */
export { SEED_BOOKS };
