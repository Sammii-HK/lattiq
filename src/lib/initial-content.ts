/**
 * initial-content.ts — Welcome content for the "Getting Started" document.
 *
 * This function is passed to CollaborationPlugin's `initialEditorState`
 * prop. It only runs when `shouldBootstrap` is true AND the Y.Doc is
 * empty (no existing content from IndexedDB or the server).
 *
 * ## How CollaborationPlugin bootstrapping works
 *
 * When shouldBootstrap=true, CollaborationPlugin checks if the shared
 * Y.XmlText (the root CRDT node) is empty. If it is, it calls this
 * function to populate the Lexical editor with initial content. Lexical
 * then syncs those nodes into the Y.Doc automatically via the binding.
 *
 * If the Y.Doc already has content (from IndexedDB or server sync),
 * shouldBootstrap is effectively ignored — the existing content wins.
 * This means this function is safe to always pass: it will never
 * overwrite existing user content.
 */

import { $createParagraphNode, $createTextNode, $getRoot, LexicalEditor } from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createListNode, $createListItemNode } from "@lexical/list";

/**
 * Populates the editor with welcome/guide content.
 *
 * Uses Lexical's $ prefix convention — these functions must run inside
 * an editor.update() callback (which CollaborationPlugin handles for us).
 *
 * The $ prefix is a Lexical convention that signals "this function reads
 * or writes editor state and must be called within an update/read context."
 * It's not a jQuery thing — it's Lexical's way of preventing accidental
 * calls outside the editor lifecycle.
 */
export function bootstrapGettingStarted(editor: LexicalEditor): void {
  editor.update(() => {
    const root = $getRoot();

    // ── Title ──────────────────────────────────────────────────────
    const heading = $createHeadingNode("h1");
    heading.append($createTextNode("Welcome to Lattiq"));
    root.append(heading);

    // ── Intro paragraph ────────────────────────────────────────────
    const intro = $createParagraphNode();
    intro.append(
      $createTextNode(
        "Lattiq is a local-first collaborative editor. Your changes are saved to this browser automatically — no account needed, no cloud dependency. If a collaboration server is running, your edits sync in real time with other users."
      )
    );
    root.append(intro);

    // ── How it works ───────────────────────────────────────────────
    const h2 = $createHeadingNode("h2");
    h2.append($createTextNode("How it works"));
    root.append(h2);

    const list = $createListNode("bullet");

    const items = [
      "Local-first: Your content lives in IndexedDB in this browser. It loads instantly, works offline, and never depends on a server.",
      "Real-time sync: When the WebSocket server is running, changes merge automatically using CRDTs (Conflict-free Replicated Data Types).",
      "Collaboration: Open this page in two browser tabs and type in both — you'll see changes appear in real time.",
      "Persistence: Every keystroke is saved. Close the tab, reopen it — your content is still here.",
    ];

    for (const text of items) {
      const item = $createListItemNode();
      item.append($createTextNode(text));
      list.append(item);
    }
    root.append(list);

    // ── Try it out ─────────────────────────────────────────────────
    const h2Try = $createHeadingNode("h2");
    h2Try.append($createTextNode("Try it out"));
    root.append(h2Try);

    const tryParagraph = $createParagraphNode();
    tryParagraph.append(
      $createTextNode(
        "Start typing below this text. Use the toolbar to format text with headings, bold, italic, lists, and more. Everything you type is saved automatically."
      )
    );
    root.append(tryParagraph);

    // ── Empty paragraph for the user to start typing ───────────────
    root.append($createParagraphNode());
  });
}
