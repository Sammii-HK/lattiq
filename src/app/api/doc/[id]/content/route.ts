/**
 * GET /api/doc/[id]/content — Serve seeded document content.
 *
 * Reads pre-seeded Yjs binary files from .lattiq-data/, extracts the
 * plain text content, and returns it as JSON for the client editor.
 *
 * ## Why server-side?
 *
 * Yjs/lib0 has a webpack bundling issue on the client (binary encoding
 * causes "Unexpected end of array"). Node.js imports yjs fine, so we
 * read .yjs files here and send plain JSON to the client.
 */

import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as Y from "yjs";

interface ContentBlock {
  type: "heading" | "paragraph";
  tag?: string;
  text: string;
}

export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const { id } = await props.params;
  const roomName = `doc-${id}`;
  const filePath = path.join(process.cwd(), ".lattiq-data", `${roomName}.yjs`);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: "Document not seeded. Run POST /api/seed first." },
      { status: 404 }
    );
  }

  try {
    const binary = fs.readFileSync(filePath);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(binary));

    // The Lexical V1 Yjs binding stores content as:
    //   root (Y.XmlText) → embedded Y.XmlText children in delta
    // Each embedded XmlText has __type attribute and text content.
    const root = doc.get("root", Y.XmlText);
    const delta = root.toDelta();

    const blocks: ContentBlock[] = [];

    for (const op of delta) {
      // Embedded XmlText elements appear as non-string inserts
      if (op.insert && typeof op.insert !== "string") {
        const xmlText = op.insert;
        // Check if it's a Y.XmlText with getAttribute
        if (xmlText && typeof xmlText.getAttribute === "function") {
          const nodeType = xmlText.getAttribute("__type") || "paragraph";
          const tag = xmlText.getAttribute("__tag");
          // Get the text content from the XmlText's own delta
          const text = xmlText.toString();

          if (text.trim()) {
            blocks.push({
              type: nodeType === "heading" ? "heading" : "paragraph",
              tag: tag || undefined,
              text: text.trim(),
            });
          }
        }
      }
    }

    doc.destroy();

    return NextResponse.json({ blocks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read document: ${message}` },
      { status: 500 }
    );
  }
}
