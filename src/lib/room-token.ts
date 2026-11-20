/**
 * Signed room tokens: "<expiry unix seconds>.<base64url HMAC-SHA256>".
 *
 * The Next.js app signs a token for a specific room with LATTIQ_ROOM_SECRET
 * (GET /api/collab-token); the room server checks it with the same secret.
 * A token only opens the room it was signed for, and only until it expires.
 * It proves "this connection came through our app for a real document",
 * which is the right bar for a public demo with no accounts. Per-user
 * permissions would replace the HMAC with a session lookup.
 *
 * Server-only: uses node:crypto and must never be imported by client code.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_TTL_SECONDS = 60 * 60;

/** Room names are `doc-` plus a lowercase slug. Nothing else reaches the filesystem. */
export const ROOM_NAME_PATTERN = /^doc-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function sign(secret: string, room: string, exp: number): string {
  return createHmac("sha256", secret).update(`${room}.${exp}`).digest("base64url");
}

export function createRoomToken(
  secret: string,
  room: string,
  now = Math.floor(Date.now() / 1000)
): string {
  const exp = now + TOKEN_TTL_SECONDS;
  return `${exp}.${sign(secret, room, exp)}`;
}

export function verifyRoomToken(
  secret: string,
  room: string,
  token: string | null | undefined,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (!token) return false;
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < now || !sig) return false;
  const expected = Buffer.from(sign(secret, room, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
