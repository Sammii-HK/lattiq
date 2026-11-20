/**
 * initial-content.ts: welcome content for the "Getting Started" document.
 *
 * This is not run in the browser. scripts/build-seeds.ts runs it inside a
 * headless Lexical editor bound to a Y.Doc with a fixed client ID, then
 * writes the resulting Yjs update to public/seed/getting-started.yjs.
 *
 * ## Why not CollaborationPlugin's `shouldBootstrap`?
 *
 * Bootstrapping writes the welcome content with the *local* client ID. Two
 * browsers that open the document before talking to each other (offline,
 * or simply racing) would each write their own copy, and the CRDT would
 * faithfully merge both copies into the document. A pre-built seed has the
 * same client ID and clocks everywhere, so applying it twice is a no-op.
 */

import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createListNode, $createListItemNode } from "@lexical/list";

/** Must run inside editor.update(). */
export function $populateGettingStarted(): void {
  const root = $getRoot();

  const heading = $createHeadingNode("h1");
  heading.append($createTextNode("Welcome to Lattiq"));
  root.append(heading);

  const intro = $createParagraphNode();
  intro.append(
    $createTextNode(
      "Lattiq is a local-first collaborative editor. Every change is saved to this browser as you type, so the document opens instantly and keeps working offline. When the sync server is reachable, edits merge in real time with everyone else in the document."
    )
  );
  root.append(intro);

  const h2 = $createHeadingNode("h2");
  h2.append($createTextNode("How it works"));
  root.append(h2);

  const list = $createListNode("bullet");
  const items = [
    "Local-first: the document is a Yjs CRDT stored in IndexedDB. Reloading, or losing your connection, never loses work.",
    "Real-time sync: a small WebSocket relay exchanges Yjs updates between browsers. Concurrent edits merge without conflicts.",
    "Presence: other people's cursors, selections and names appear as they move.",
    "Offline merge: edits made while disconnected are reconciled automatically when the connection returns.",
  ];
  for (const text of items) {
    const item = $createListItemNode();
    item.append($createTextNode(text));
    list.append(item);
  }
  root.append(list);

  const h2Try = $createHeadingNode("h2");
  h2Try.append($createTextNode("Try it out"));
  root.append(h2Try);

  const tryParagraph = $createParagraphNode();
  tryParagraph.append(
    $createTextNode(
      "Open this page in a second browser window and type in both. Then switch your network off, keep typing, and switch it back on."
    )
  );
  root.append(tryParagraph);

  root.append($createParagraphNode());
}
