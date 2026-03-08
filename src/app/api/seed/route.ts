/**
 * POST /api/seed — Trigger Gutenberg book seeding.
 *
 * ## What this route does
 *
 * It downloads public domain books from Project Gutenberg, converts them
 * into Yjs documents, and saves them as .yjs binary files. The WebSocket
 * server will automatically pick them up on the next client connection.
 *
 * ## Why a POST route?
 *
 * Seeding is a side-effect (it writes files to disk), so it should be POST,
 * not GET. GET requests should be safe and idempotent — seeding is idempotent
 * (you can run it multiple times) but it's not safe (it makes HTTP requests
 * to external servers and writes to disk).
 *
 * ## How to trigger it
 *
 * From the browser console:
 *   fetch('/api/seed', { method: 'POST' }).then(r => r.json()).then(console.log)
 *
 * From the command line:
 *   curl -X POST http://localhost:3000/api/seed
 *
 * ## Response format
 *
 * Returns a JSON object with:
 *   - results: Array of SeedResult objects (one per book)
 *   - summary: { succeeded, failed, total }
 *
 * Each SeedResult includes the book title, author, file size, block count,
 * and whether it succeeded. This lets you see exactly what was seeded.
 */

import { NextResponse } from "next/server";
import { seedDocuments } from "@/lib/seed/seed-documents";

export async function POST() {
  try {
    // seedDocuments() does all the heavy lifting: downloading, converting,
    // and persisting. It handles errors per-book, so even if one book fails,
    // the others will still be seeded.
    const results = await seedDocuments();

    // Build a summary for easy consumption
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      results,
      summary: {
        succeeded,
        failed,
        total: results.length,
      },
    });
  } catch (error) {
    // This catches unexpected errors (not per-book failures, which are
    // handled inside seedDocuments). Something went very wrong.
    console.error("Seed route error:", error);

    return NextResponse.json(
      {
        error: "Seeding failed",
        message:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
