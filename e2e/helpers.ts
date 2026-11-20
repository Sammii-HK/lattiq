import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export type SyncState = "loading" | "local" | "connecting" | "syncing" | "synced" | "offline" | "error";

export interface Client {
  context: BrowserContext;
  page: Page;
  errors: string[];
}

/** A fresh browser profile (its own IndexedDB), with console errors collected. */
export async function newClient(browser: Browser): Promise<Client> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // The browser logs a failed WebSocket handshake while the server is down; expected offline.
    if (/WebSocket connection to .* failed/.test(text)) return;
    if (/Failed to load resource/.test(text) && /collab-token/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return { context, page, errors };
}

export async function openDoc(page: Page, docId: string) {
  await page.goto(`/doc/${docId}`);
  await expect(page.getByTestId("editor")).toHaveAttribute("data-ready", "true");
}

export async function expectState(page: Page, state: SyncState, timeout = 20_000) {
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", state, { timeout });
}

export function editorText(page: Page): Promise<string> {
  return page.locator(".editor-input").evaluate((el) => el.textContent ?? "");
}

export function blockCount(page: Page): Promise<number> {
  return page.locator(".editor-input").evaluate((el) => el.children.length);
}

/**
 * Put the caret at the start or end of the document, then type with real
 * key events. The caret is placed through the DOM selection, which Lexical
 * picks up exactly as it would a click.
 */
export async function typeAt(page: Page, where: "start" | "end", text: string, delay = 0) {
  const editor = page.locator(".editor-input");
  await editor.click();
  await editor.evaluate((el, where) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const range = document.createRange();
    if (nodes.length === 0) {
      range.selectNodeContents(el);
      range.collapse(where === "start");
    } else if (where === "start") {
      range.setStart(nodes[0], 0);
      range.collapse(true);
    } else {
      const last = nodes[nodes.length - 1];
      range.setStart(last, last.length);
      range.collapse(true);
    }
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, where);
  // Let Lexical read the selection change before typing.
  await page.waitForTimeout(50);
  await page.keyboard.type(text, { delay });
}

export async function expectNoErrors(...clients: Client[]) {
  for (const c of clients) expect(c.errors, "console errors").toEqual([]);
}
