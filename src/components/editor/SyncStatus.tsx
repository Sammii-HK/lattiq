/**
 * SyncStatus — Visual indicator showing the current document sync state.
 *
 * In a local-first app, users need constant reassurance that their data
 * is safe. This component provides that through a simple coloured dot
 * and label:
 *
 *   - Yellow pulsing dot + "Loading..."     → restoring from IndexedDB
 *   - Green dot + "Saved locally"           → offline, data is in IndexedDB
 *   - Blue pulsing dot + "Syncing..."       → connecting to server
 *   - Blue dot + "Synced"                   → fully synced with server
 *   - Orange dot + "Offline"                → was connected, now offline
 *
 * ## Design decisions
 *
 * - The dot pulses during transitional states (loading, syncing) to
 *   indicate ongoing activity without being distracting.
 * - "Offline" gets an orange dot (not red) because it's not an error —
 *   local-first means offline is a perfectly valid state. Your data is
 *   safe in IndexedDB and will sync when the connection returns.
 * - The component uses role="status" and aria-label for accessibility —
 *   screen readers announce status changes.
 */

"use client";

import type { SyncStatus as SyncStatusType } from "@/hooks/useCollaboration";

/**
 * Configuration for each sync status.
 *
 * Using a lookup object instead of a switch statement makes it easy to
 * add new states and keeps the component render function minimal.
 */
const STATUS_CONFIG: Record<
  SyncStatusType,
  { label: string; dotClass: string }
> = {
  "loading-local": {
    label: "Loading\u2026",
    dotClass: "sync-dot sync-dot-loading",
  },
  "local-only": {
    label: "Saved locally",
    dotClass: "sync-dot sync-dot-local",
  },
  syncing: {
    label: "Syncing\u2026",
    dotClass: "sync-dot sync-dot-syncing",
  },
  synced: {
    label: "Synced",
    dotClass: "sync-dot sync-dot-synced",
  },
  offline: {
    label: "Offline",
    dotClass: "sync-dot sync-dot-offline",
  },
};

export default function SyncStatus({ status }: { status: SyncStatusType }) {
  const config = STATUS_CONFIG[status];

  return (
    <div className="sync-status" role="status" aria-label={config.label}>
      <span className={config.dotClass} />
      <span className="sync-label">{config.label}</span>
    </div>
  );
}
