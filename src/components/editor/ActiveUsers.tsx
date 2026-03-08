/**
 * ActiveUsers — Shows avatars of all connected collaborators.
 *
 * ## How presence works in Yjs
 *
 * Yjs's Awareness protocol is separate from the CRDT document sync.
 * While the Y.Doc uses CRDTs for persistent, conflict-free data,
 * Awareness handles ephemeral per-user state:
 *
 *   - Cursor position and selection range
 *   - User name, colour, and avatar
 *   - Online/typing status
 *
 * Awareness uses a simple last-write-wins model — each user "owns"
 * their own state and can overwrite it freely. There's no conflict
 * resolution because there's no conflict: only you can set your cursor.
 *
 * ## Why separate from the CRDT?
 *
 * Cursor positions are:
 *   1. High-frequency (every mouse move or keystroke)
 *   2. Ephemeral (you don't want yesterday's cursor showing today)
 *   3. Per-user (no conflicts possible)
 *
 * CRDTs would be overkill for this — they'd persist cursor history forever
 * and waste bandwidth on conflict resolution that isn't needed.
 *
 * ## The states Map
 *
 * awareness.getStates() returns a Map<number, object> where:
 *   - Key: Yjs clientID (unique per browser tab)
 *   - Value: the state object set by that client via setLocalStateField
 *
 * We filter out our own clientID (doc.clientID) since you don't need
 * to see your own avatar in the presence bar.
 */

"use client";

import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

interface UserState {
  name: string;
  colour: string;
}

interface ActiveUsersProps {
  /** The Awareness instance from the collaboration provider */
  awareness: Awareness | null;
  /** Our own Yjs clientID — used to filter ourselves out */
  localClientID: number;
}

export default function ActiveUsers({
  awareness,
  localClientID,
}: ActiveUsersProps) {
  // Store the list of remote users (excluding ourselves).
  const [users, setUsers] = useState<Map<number, UserState>>(new Map());

  useEffect(() => {
    if (!awareness) return;

    /**
     * Update our user list whenever awareness changes.
     *
     * The 'change' event fires when:
     *   - A new user connects (added)
     *   - A user's state changes, e.g. cursor moves (updated)
     *   - A user disconnects (removed)
     *
     * We rebuild the entire user map from awareness.getStates() rather
     * than trying to incrementally update. This is simpler and the number
     * of users is always small (typically < 20), so performance is fine.
     */
    function handleChange() {
      const states = awareness!.getStates();
      const remoteUsers = new Map<number, UserState>();

      states.forEach((state, clientID) => {
        // Skip our own entry — we don't need to see ourselves.
        if (clientID === localClientID) return;

        // Skip clients that haven't set user info yet (just connected).
        const user = state.user as UserState | undefined;
        if (user?.name) {
          remoteUsers.set(clientID, user);
        }
      });

      setUsers(remoteUsers);
    }

    // Listen for awareness changes.
    awareness.on("change", handleChange);

    // Run once immediately to pick up any existing users.
    handleChange();

    return () => {
      awareness.off("change", handleChange);
    };
  }, [awareness, localClientID]);

  // Don't render anything if nobody else is connected.
  if (users.size === 0) return null;

  return (
    <div className="active-users" aria-label="Active collaborators">
      {Array.from(users.entries()).map(([clientID, user]) => (
        <div
          key={clientID}
          className="user-avatar"
          style={{ backgroundColor: user.colour }}
          title={user.name}
        >
          {/* Show the first letter of the user's name as their avatar. */}
          {user.name[0].toUpperCase()}
        </div>
      ))}
    </div>
  );
}
