/**
 * SyncStatus — Visual indicator showing the current document sync state.
 *
 * In a local-first app, users need to know whether their data is:
 * - Being loaded from local storage ("Loading...")
 * - Saved locally and ready ("Saved locally")
 *
 * Phase 3 will add additional states:
 * - Syncing to server ("Syncing...")
 * - Fully synced with server ("Synced")
 * - Offline / disconnected ("Offline — changes saved locally")
 */

"use client";

import type { SyncStatus as SyncStatusType } from "@/hooks/useCollaboration";

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
