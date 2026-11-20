/**
 * GET /api/collab-token?doc=<id>: a short-lived token for one document's room.
 *
 * Returns { token: null } when LATTIQ_ROOM_SECRET isn't set, which is the
 * local development setup: the room server is then open too. Only documents
 * that exist in the app get a token, so the server can't be used as a
 * general-purpose relay for arbitrary room names.
 */

import { NextResponse } from "next/server";
import { getDocumentById } from "@/lib/constants";
import { createRoomToken } from "@/lib/room-token";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const docId = new URL(request.url).searchParams.get("doc") ?? "";
  if (!getDocumentById(docId)) {
    return NextResponse.json({ error: "Unknown document" }, { status: 404 });
  }

  const secret = process.env.LATTIQ_ROOM_SECRET;
  const token = secret ? createRoomToken(secret, `doc-${docId}`) : null;

  return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
