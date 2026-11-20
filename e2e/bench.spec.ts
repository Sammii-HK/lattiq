/**
 * Benchmarks (pnpm bench). Production build, localhost, system Chrome,
 * headless. Results go to bench/results.json and a table on stdout.
 *
 *   1. Load time for Pride and Prejudice (~122K words, 2,509 blocks):
 *      cold (empty IndexedDB, seed fetched over HTTP), warm (IndexedDB),
 *      and warm with the sync server down.
 *   2. Keystroke-to-remote latency between two browser contexts.
 *   3. Offline edit merge: two clients edit while the server is down; time
 *      from each socket reopening to both documents converging.
 */

import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as Y from "yjs";
import { RoomServer } from "./room-server";
import { editorText, expectState, newClient, openDoc, typeAt } from "./helpers";

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const KEYSTROKES = Number(process.env.BENCH_KEYSTROKES ?? 100);
const MERGE_RUNS = Number(process.env.BENCH_MERGE_RUNS ?? 5);

const server = new RoomServer();
const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  environment: {
    machine: `${os.cpus()[0]?.model ?? process.arch}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${process.platform}`,
    loadAverageAtStart: os.loadavg().map((l) => Math.round(l * 10) / 10),
    node: process.version,
    browser: "system Chrome, headless (Playwright channel 'chrome')",
    build: "next build + next start (production)",
    network: "localhost, no throttling",
  },
};

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    n: values.length,
    median: r(q(0.5)),
    p95: r(q(0.95)),
    min: r(sorted[0]),
    max: r(sorted[sorted.length - 1]),
  };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await server.start();
  (results.environment as Record<string, unknown>).browser =
    `Chrome ${browser.version()}, headless (Playwright channel 'chrome')`;
});

test.afterAll(async () => {
  await server.dispose();
  fs.mkdirSync("bench", { recursive: true });
  fs.writeFileSync("bench/results.json", JSON.stringify(results, null, 2) + "\n");
  console.log("\n" + JSON.stringify(results, null, 2));
});

// ── 1. Load time ──────────────────────────────────────────────────────

const BOOK = "pride-and-prejudice";

function seedBlockCount(docId: string): number {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(path.join("public/seed", `${docId}.yjs`))));
  return doc.get("root", Y.XmlText).toDelta().length;
}

/** ms from navigation start until every block of the book is in the editor DOM. */
async function loadBook(page: Page, blocks: number) {
  await page.goto(`/doc/${BOOK}`);
  const handle = await page.waitForFunction(
    (n) => {
      const el = document.querySelector(".editor-input");
      return el && el.children.length >= n ? performance.now() : false;
    },
    blocks,
    { polling: "raf", timeout: 60_000 }
  );
  const renderedAt = (await handle.jsonValue()) as number;
  const timings = await page.evaluate(() => {
    const t = (window as unknown as { __lattiq: { timings: Record<string, unknown> } }).__lattiq
      .timings;
    return { localLoadedAt: t.localLoadedAt, seedAppliedAt: t.seedAppliedAt };
  });
  return { renderedAt, ...timings } as {
    renderedAt: number;
    localLoadedAt?: number;
    seedAppliedAt?: number;
  };
}

/** Wait until y-indexeddb has written the document, so a reload reads it back. */
async function waitForIndexedDb(page: Page, docId: string) {
  for (let i = 0; i < 100; i++) {
    const count = await page.evaluate(
      (name) =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open(name);
          req.onerror = () => resolve(0);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("updates")) {
              db.close();
              return resolve(0);
            }
            const c = db.transaction("updates", "readonly").objectStore("updates").count();
            c.onsuccess = () => {
              resolve(c.result);
              db.close();
            };
            c.onerror = () => resolve(0);
          };
        }),
      `lattiq:${docId}`
    );
    if (count > 0) return;
    await page.waitForTimeout(50);
  }
  throw new Error("IndexedDB never received the document");
}

test("@bench load time: full-length book", async ({ browser }) => {
  const blocks = seedBlockCount(BOOK);
  const words = fs.readFileSync(path.join(".lattiq-cache", "1342.txt"), "utf8").split(/\s+/).length;
  const cold: number[] = [];
  const coldSeedApplied: number[] = [];
  const warm: number[] = [];
  const warmIdb: number[] = [];
  const warmOffline: number[] = [];

  // Prime the HTTP and Next caches so run 1 isn't an outlier from compilation.
  const primer = await newClient(browser);
  await loadBook(primer.page, blocks);
  await primer.context.close();

  for (let i = 0; i < RUNS; i++) {
    const c = await newClient(browser);
    const first = await loadBook(c.page, blocks);
    cold.push(first.renderedAt);
    if (first.seedAppliedAt) coldSeedApplied.push(first.seedAppliedAt);
    await expectState(c.page, "synced");
    await waitForIndexedDb(c.page, BOOK);

    const second = await loadBook(c.page, blocks);
    warm.push(second.renderedAt);
    if (second.localLoadedAt) warmIdb.push(second.localLoadedAt);
    expect(second.seedAppliedAt, "warm load must not refetch the seed").toBeUndefined();
    await c.context.close();
  }

  await server.stop();
  for (let i = 0; i < RUNS; i++) {
    const c = await newClient(browser);
    // Populate IndexedDB while online is impossible with the server down, so
    // the first (cold) load here seeds from HTTP; the measured one is the reload.
    await loadBook(c.page, blocks);
    await waitForIndexedDb(c.page, BOOK);
    const offline = await loadBook(c.page, blocks);
    expect(offline.seedAppliedAt, "warm load must not refetch the seed").toBeUndefined();
    warmOffline.push(offline.renderedAt);
    await c.context.close();
  }
  await server.start();

  results.load = {
    document: `Pride and Prejudice: ${words.toLocaleString("en-GB")} words, ${blocks.toLocaleString("en-GB")} blocks`,
    seedBytes: fs.statSync(path.join("public/seed", `${BOOK}.yjs`)).size,
    measure: "navigation start to every block in the editor DOM (polled per animation frame)",
    coldMs: stats(cold),
    coldSeedAppliedMs: stats(coldSeedApplied),
    warmMs: stats(warm),
    warmIndexedDbLoadedMs: stats(warmIdb),
    warmServerDownMs: stats(warmOffline),
  };
});

// ── 2. Keystroke-to-remote latency ────────────────────────────────────

test("@bench keystroke-to-remote latency", async ({ browser }) => {
  const a = await newClient(browser);
  const b = await newClient(browser);
  await openDoc(a.page, "scratch-pad");
  await openDoc(b.page, "scratch-pad");
  await expectState(a.page, "synced");
  await expectState(b.page, "synced");
  await typeAt(a.page, "end", "Latency: ");
  await expect.poll(() => editorText(b.page)).toContain("Latency: ");

  // A records when each key goes down (capture phase, before Lexical sees
  // it); B records when its editor text grows. Both use epoch-based
  // high-resolution time, so the clocks are comparable across pages.
  await a.page.evaluate(() => {
    const w = window as unknown as { __sent: number[] };
    w.__sent = [];
    document.addEventListener(
      "keydown",
      () => w.__sent.push(performance.timeOrigin + performance.now()),
      true
    );
  });
  const baseLength = (await editorText(b.page)).length;
  await b.page.evaluate((base) => {
    const w = window as unknown as { __recv: number[] };
    w.__recv = [];
    const el = document.querySelector(".editor-input")!;
    new MutationObserver(() => {
      const len = (el.textContent ?? "").length;
      while (w.__recv.length < len - base) w.__recv.push(performance.timeOrigin + performance.now());
    }).observe(el, { subtree: true, childList: true, characterData: true });
  }, baseLength);

  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < KEYSTROKES; i++) {
    await a.page.keyboard.press(alphabet[i % alphabet.length]);
    // One keystroke in flight at a time, so each measurement is independent.
    await b.page.waitForFunction(
      (n) => (window as unknown as { __recv: number[] }).__recv.length >= n,
      i + 1,
      { polling: "raf" }
    );
  }

  const sent = await a.page.evaluate(() => (window as unknown as { __sent: number[] }).__sent);
  const recv = await b.page.evaluate(() => (window as unknown as { __recv: number[] }).__recv);
  const latencies = recv.slice(0, KEYSTROKES).map((t, i) => t - sent[i]);
  expect(latencies.every((l) => l > 0)).toBe(true);

  results.keystrokeLatency = {
    measure: "keydown in client A to the character appearing in client B's DOM, via the room server",
    ms: stats(latencies),
  };
  await Promise.all([a.context.close(), b.context.close()]);
});

// ── 3. Offline edit merge ─────────────────────────────────────────────

test("@bench offline edit merge", async ({ browser }) => {
  const runs: { reconnectToConvergedMs: number; serverUpToConvergedMs: number; chars: number }[] = [];

  for (let run = 0; run < MERGE_RUNS; run++) {
    const a = await newClient(browser);
    const b = await newClient(browser);
    await openDoc(a.page, "project-roadmap");
    await openDoc(b.page, "project-roadmap");
    await expectState(a.page, "synced");
    await expectState(b.page, "synced");

    await server.stop();
    await expectState(a.page, "offline");
    await expectState(b.page, "offline");

    // ~200 characters each, in different places, while offline.
    const tagA = `[run ${run} A]`;
    const tagB = `[run ${run} B]`;
    const textA = ` ${tagA} ${"Offline paragraph from A. ".repeat(7)}`;
    const textB = `${tagB} ${"Offline paragraph from B. ".repeat(7)} `;
    await typeAt(a.page, "end", textA);
    await typeAt(b.page, "start", textB);

    const upAt = Date.now();
    await server.start();
    const converged = async (page: Page) => {
      await page.waitForFunction(
        ([x, y]) => {
          const t = document.querySelector(".editor-input")?.textContent ?? "";
          return t.includes(x) && t.includes(y);
        },
        [tagA, tagB],
        { polling: "raf", timeout: 60_000 }
      );
      return page.evaluate(() => {
        const s = (
          window as unknown as {
            __lattiq: { timings: { statusLog: { status: string; at: number }[] } };
          }
        ).__lattiq;
        const opened = [...s.timings.statusLog].reverse().find((e) => e.status === "connected");
        return {
          convergedAt: performance.timeOrigin + performance.now(),
          reconnectedAt: opened ? performance.timeOrigin + opened.at : NaN,
        };
      });
    };
    const [ra, rb] = await Promise.all([converged(a.page), converged(b.page)]);
    expect(await editorText(a.page)).toBe(await editorText(b.page));

    runs.push({
      // Neither client can hold the other's edits until both sockets are
      // open, so the merge window starts at the later of the two reconnects.
      reconnectToConvergedMs:
        Math.max(ra.convergedAt, rb.convergedAt) - Math.max(ra.reconnectedAt, rb.reconnectedAt),
      // Includes the reconnect backoff, which dominates.
      serverUpToConvergedMs: Math.max(ra.convergedAt, rb.convergedAt) - upAt,
      chars: textA.length + textB.length,
    });
    await Promise.all([a.context.close(), b.context.close()]);
  }

  results.offlineMerge = {
    measure:
      "two clients each type ~190 chars while the server is down; time from both sockets being open again until both hold both edits",
    reconnectToConvergedMs: stats(runs.map((r) => r.reconnectToConvergedMs)),
    serverUpToConvergedMs: stats(runs.map((r) => r.serverUpToConvergedMs)),
    note: "serverUpToConverged includes the client's reconnect backoff (0.5s doubling to a 30s cap, with jitter)",
    runs,
  };
});
