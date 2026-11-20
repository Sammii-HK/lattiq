/**
 * build-seeds.ts: generate public/seed/<docId>.yjs for every seeded document.
 *
 *   pnpm seed                 # all documents
 *   pnpm seed getting-started # just one
 *
 * Each seed is produced by a headless Lexical editor bound to a Y.Doc through
 * Lexical's own Yjs binding (createBinding + syncLexicalUpdateToYjs), the
 * same code path the browser uses. The Y.Doc has a fixed client ID so the
 * output is a deterministic set of CRDT operations: the browser, the sync
 * server and a second browser can all apply the same file and end up with
 * one copy of the content, not three.
 *
 * Gutenberg texts are downloaded once and cached in .lattiq-cache/.
 */

import * as fs from "fs";
import * as path from "path";
import * as Y from "yjs";
import { createHeadlessEditor } from "@lexical/headless";
import { createBinding, syncLexicalUpdateToYjs } from "@lexical/yjs";
import type { Provider } from "@lexical/yjs";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { HeadingNode, QuoteNode, $createHeadingNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode, AutoLinkNode } from "@lexical/link";

import { $populateGettingStarted } from "../src/lib/initial-content";
import { parseTextToBlocks, type TextBlock } from "../src/lib/seed/parse-text";
import { fetchGutenbergBook, stripGutenbergBoilerplate } from "../src/lib/seed/gutenberg";
import { SEED_BOOKS, SEED_CLIENT_ID } from "../src/lib/seed/books";

const OUT_DIR = path.join(process.cwd(), "public", "seed");
const CACHE_DIR = path.join(process.cwd(), ".lattiq-cache");

/** Only awareness is read by the binding; a null local state skips cursor sync. */
const stubProvider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    on: () => {},
    off: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  },
  connect: () => {},
  disconnect: () => {},
  on: () => {},
  off: () => {},
} as unknown as Provider;

function buildSeed(populate: () => void): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = SEED_CLIENT_ID;

  const editor = createHeadlessEditor({
    namespace: "LattiqEditor",
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      CodeHighlightNode,
      LinkNode,
      AutoLinkNode,
    ],
    onError: (e) => {
      throw e;
    },
  });

  const binding = createBinding(editor, stubProvider, "seed", doc, new Map([["seed", doc]]));

  editor.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        stubProvider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags
      );
    }
  );

  editor.update(
    () => {
      $getRoot().clear();
      populate();
    },
    { discrete: true }
  );

  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function $appendBlocks(blocks: TextBlock[]) {
  const root = $getRoot();
  for (const block of blocks) {
    const node =
      block.type === "heading" ? $createHeadingNode(block.tag ?? "h2") : $createParagraphNode();
    node.append($createTextNode(block.content));
    root.append(node);
  }
}

async function bookText(gutenbergId: number): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, `${gutenbergId}.txt`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, "utf8");
  let text: string;
  try {
    ({ text } = await fetchGutenbergBook(gutenbergId));
  } catch (err) {
    // gutenberg.org is sometimes down for maintenance; pglaf is an official mirror.
    const mirror = `https://gutenberg.pglaf.org/cache/epub/${gutenbergId}/pg${gutenbergId}.txt`;
    console.log(`  gutenberg.org failed (${(err as Error).message}), trying ${mirror}`);
    const res = await fetch(mirror);
    if (!res.ok) throw new Error(`Mirror download failed: ${res.status}`);
    text = stripGutenbergBoilerplate(await res.text());
  }
  console.log(`  downloaded #${gutenbergId} (${text.length.toLocaleString()} chars)`);
  fs.writeFileSync(cached, text);
  return text;
}

function write(docId: string, update: Uint8Array, blockCount: number) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${docId}.yjs`), update);
  console.log(
    `  ${docId}.yjs  ${(update.length / 1024).toFixed(1)} KB, ${blockCount.toLocaleString()} blocks`
  );
}

async function main() {
  const only = process.argv[2];

  if (!only || only === "getting-started") {
    console.log("getting-started");
    write("getting-started", buildSeed($populateGettingStarted), 6);
  }

  for (const book of SEED_BOOKS) {
    if (only && only !== book.docId) continue;
    console.log(book.docId);
    const blocks = parseTextToBlocks(await bookText(book.gutenbergId));
    write(book.docId, buildSeed(() => $appendBlocks(blocks)), blocks.length);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
