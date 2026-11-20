"use client";

import type { SyncState } from "@/lib/yjs/doc-session";

const STATUS: Record<SyncState, { label: string; dot: string; hint: string }> = {
  loading: {
    label: "Opening…",
    dot: "sync-dot sync-dot-loading",
    hint: "Loading the document from this device.",
  },
  local: {
    label: "Saved on this device",
    dot: "sync-dot sync-dot-local",
    hint: "No sync server is configured, so edits stay in this browser.",
  },
  connecting: {
    label: "Connecting…",
    dot: "sync-dot sync-dot-syncing",
    hint: "Edits are saved locally while the connection opens.",
  },
  syncing: {
    label: "Syncing…",
    dot: "sync-dot sync-dot-syncing",
    hint: "Exchanging changes with the server.",
  },
  synced: {
    label: "Synced",
    dot: "sync-dot sync-dot-synced",
    hint: "Edits are shared live with everyone in the document.",
  },
  offline: {
    label: "Offline, saved locally",
    dot: "sync-dot sync-dot-offline",
    hint: "Your edits are safe in this browser and will merge when the connection returns.",
  },
  error: {
    label: "Sync unavailable",
    dot: "sync-dot sync-dot-offline",
    hint: "The server refused the connection. Edits are still saved in this browser.",
  },
};

export default function SyncStatus({ state }: { state: SyncState }) {
  const s = STATUS[state];
  return (
    <div className="sync-status" role="status" title={s.hint} data-testid="sync-status" data-state={state}>
      <span className={s.dot} />
      <span className="sync-label">{s.label}</span>
    </div>
  );
}
