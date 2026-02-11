/**
 * LocalProvider — A local-only Provider that satisfies the @lexical/yjs Provider interface.
 *
 * ## Why does this exist?
 *
 * Lexical's CollaborationPlugin requires a "Provider" — an object that can
 * connect(), disconnect(), and emit events like 'sync' and 'status'. Normally
 * this would be a WebSocket provider (e.g. y-websocket's WebsocketProvider)
 * that talks to a remote server.
 *
 * In Phase 2 we don't have a server yet, so LocalProvider acts as a stand-in:
 * - connect()  → immediately emits 'sync'(true) and 'status'({ status: 'connected' })
 * - disconnect() → emits 'status'({ status: 'disconnected' })
 *
 * When we add real networking in Phase 3, we'll swap this out for a
 * WebSocket-backed provider. The rest of the editor code doesn't change.
 *
 * ## The Provider interface contract
 *
 * CollaborationPlugin expects these methods:
 *   - connect()       — start syncing (we just say "already done")
 *   - disconnect()    — stop syncing
 *   - on(event, cb)   — subscribe to events: 'sync', 'status', 'update', 'reload'
 *   - off(event, cb)  — unsubscribe from events
 *   - awareness       — an Awareness instance for cursor/presence tracking
 */

import { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";
import type { Provider, ProviderAwareness } from "@lexical/yjs";

// Event types that CollaborationPlugin can subscribe to
type EventType = "sync" | "status" | "update" | "reload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventCallback = (...args: any[]) => void;

export class LocalProvider implements Provider {
  /**
   * Awareness tracks per-user state (cursor position, name, color).
   * Even in single-user mode, CollaborationPlugin reads this to render
   * the local cursor. We create a real Awareness instance backed by our Y.Doc.
   *
   * The type cast is needed because y-protocols Awareness uses a loose
   * `{ [x: string]: any }` return type for getLocalState(), while Lexical's
   * ProviderAwareness expects a stricter UserState. At runtime the objects
   * are the same — this is purely a TypeScript compatibility shim.
   */
  awareness: ProviderAwareness;

  private listeners: Map<EventType, Set<EventCallback>> = new Map();

  constructor(doc: Doc) {
    this.awareness = new Awareness(doc) as unknown as ProviderAwareness;
  }

  /**
   * In a real provider, connect() would open a WebSocket and start syncing.
   * Here we immediately signal "connected and synced" so CollaborationPlugin
   * initializes the editor right away.
   *
   * We use setTimeout(0) so listeners registered after connect() still fire.
   */
  connect(): void {
    setTimeout(() => {
      this.emit("status", { status: "connected" });
      this.emit("sync", true);
    }, 0);
  }

  /**
   * In a real provider, disconnect() would close the WebSocket.
   * Here we just signal that we're no longer "connected".
   */
  disconnect(): void {
    this.emit("status", { status: "disconnected" });
  }

  // ── Event emitter methods ──────────────────────────────────

  on(type: EventType, cb: EventCallback): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(cb);
  }

  off(type: EventType, cb: EventCallback): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(type: EventType, ...args: unknown[]): void {
    this.listeners.get(type)?.forEach((cb) => cb(...args));
  }
}
