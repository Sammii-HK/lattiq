import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import * as Y from "yjs";
import { RoomServer } from "./room-server";
import { WS_URL } from "./env";
import {
  blockCount,
  editorText,
  expectNoErrors,
  expectState,
  newClient,
  openDoc,
  typeAt,
} from "./helpers";

const server = new RoomServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.dispose();
});

test("two clients sync edits both ways, with presence", async ({ browser }) => {
  const a = await newClient(browser);
  const b = await newClient(browser);
  await openDoc(a.page, "scratch-pad");
  await openDoc(b.page, "scratch-pad");
  await expectState(a.page, "synced");
  await expectState(b.page, "synced");

  await typeAt(a.page, "end", "Hello from A.");
  await expect.poll(() => editorText(b.page)).toContain("Hello from A.");

  await typeAt(b.page, "end", " Reply from B.");
  await expect.poll(() => editorText(a.page)).toContain("Hello from A. Reply from B.");
  expect(await editorText(a.page)).toBe(await editorText(b.page));

  // Presence: each sees two people, and A's caret is drawn in B's editor.
  await expect(a.page.getByTestId("active-users")).toHaveAttribute("data-count", "2");
  await expect(b.page.getByTestId("active-users")).toHaveAttribute("data-count", "2");
  const aName = await a.page.evaluate(
    () => (window as unknown as { __lattiq: { identity: { name: string } } }).__lattiq.identity.name
  );
  await typeAt(a.page, "end", "!");
  await expect(b.page.locator(".cursors-container")).toContainText(aName);

  // When A leaves, B's presence updates.
  await a.context.close();
  await expect(b.page.getByTestId("active-users")).toHaveAttribute("data-count", "1");

  await expectNoErrors(a, b);
  await b.context.close();
});

test("offline edits survive a reload and merge on reconnect", async ({ browser }) => {
  const a = await newClient(browser);
  const b = await newClient(browser);
  await openDoc(a.page, "meeting-notes");
  await openDoc(b.page, "meeting-notes");
  await expectState(a.page, "synced");
  await expectState(b.page, "synced");

  await typeAt(a.page, "end", "Agreed: ship on Friday.");
  await expect.poll(() => editorText(b.page)).toContain("Agreed: ship on Friday.");

  // Take the server away. Both keep editing, in different places.
  await server.stop();
  await expectState(a.page, "offline");
  await expectState(b.page, "offline");
  await typeAt(a.page, "end", " A adds this offline.");
  await typeAt(b.page, "start", "B wrote this offline. ");

  // Reload A with the server still down: the offline edit comes back from IndexedDB.
  await a.page.reload();
  await expect(a.page.getByTestId("editor")).toHaveAttribute("data-ready", "true");
  await expect.poll(() => editorText(a.page)).toContain("A adds this offline.");
  expect(await editorText(a.page)).not.toContain("B wrote this offline.");
  await expectState(a.page, "offline");

  // Bring the server back: both converge on both edits.
  await server.start();
  await expectState(a.page, "synced", 40_000);
  await expectState(b.page, "synced", 40_000);
  const expected = "B wrote this offline. Agreed: ship on Friday. A adds this offline.";
  await expect.poll(() => editorText(a.page)).toBe(expected);
  await expect.poll(() => editorText(b.page)).toBe(expected);

  // The server persisted the merge: restart it and open a brand-new profile.
  await a.page.waitForTimeout(2500); // persistence is debounced by 2s
  await server.stop();
  await server.start();
  const c = await newClient(browser);
  await openDoc(c.page, "meeting-notes");
  await expectState(c.page, "synced");
  await expect.poll(() => editorText(c.page)).toBe(expected);

  await expectNoErrors(a, b, c);
  await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
});

test("a seeded book appears once, though both the browser and the server apply the seed", async ({
  browser,
}) => {
  const seed = fs.readFileSync(path.join("public/seed/the-yellow-wallpaper.yjs"));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(seed));
  const expectedBlocks = doc.get("root", Y.XmlText).toDelta().length;

  const a = await newClient(browser);
  await openDoc(a.page, "the-yellow-wallpaper");
  await expectState(a.page, "synced");
  await expect.poll(() => blockCount(a.page)).toBe(expectedBlocks);

  // A second profile, and a reload: still one copy.
  const b = await newClient(browser);
  await openDoc(b.page, "the-yellow-wallpaper");
  await expectState(b.page, "synced");
  await a.page.reload();
  await expectState(a.page, "synced");
  expect(await blockCount(a.page)).toBe(expectedBlocks);
  expect(await blockCount(b.page)).toBe(expectedBlocks);

  await expectNoErrors(a, b);
  await Promise.all([a.context.close(), b.context.close()]);
});

function closeCode(url: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve("open");
    }, 1500);
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on("error", () => {});
  });
}

test("the server rejects bad room names and missing or forged tokens", async ({ request }) => {
  expect(await closeCode(`${WS_URL}/..%2F..%2Fetc%2Fpasswd`)).toBe(4400);
  expect(await closeCode(`${WS_URL}/Doc-UPPER`)).toBe(4400);
  expect(await closeCode(`${WS_URL}/doc-scratch-pad`)).toBe(4401);
  expect(await closeCode(`${WS_URL}/doc-scratch-pad?token=9999999999.forged`)).toBe(4401);

  const { token } = await (await request.get("/api/collab-token?doc=scratch-pad")).json();
  expect(await closeCode(`${WS_URL}/doc-scratch-pad?token=${encodeURIComponent(token)}`)).toBe("open");
  // A token for one room doesn't open another.
  expect(await closeCode(`${WS_URL}/doc-meeting-notes?token=${encodeURIComponent(token)}`)).toBe(4401);

  expect((await request.get("/api/collab-token?doc=not-a-doc")).status()).toBe(404);
});

test("pages hydrate without errors", async ({ browser }) => {
  const a = await newClient(browser);
  for (const path of ["/", "/doc/getting-started", "/doc/pride-and-prejudice"]) {
    await a.page.goto(path);
    await a.page.waitForLoadState("networkidle");
  }
  await expectNoErrors(a);
  await a.context.close();
});
