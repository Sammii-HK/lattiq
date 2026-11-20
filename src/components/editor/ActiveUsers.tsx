"use client";

/**
 * ActiveUsers: avatars for everyone in the document, from Yjs awareness.
 *
 * Lexical's CollaborationPlugin owns the local awareness state and writes
 * { name, color, focusing, anchorPos, focusPos } for each client, so that's
 * the shape read here. Awareness is ephemeral: when a client disconnects,
 * the server removes its state and the avatar disappears.
 */

import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

interface Person {
  clientID: number;
  name: string;
  color: string;
  isLocal: boolean;
  focusing: boolean;
}

export default function ActiveUsers({ awareness }: { awareness: Awareness }) {
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    const update = () => {
      const list: Person[] = [];
      awareness.getStates().forEach((state, clientID) => {
        if (typeof state.name !== "string" || !state.name) return;
        list.push({
          clientID,
          name: state.name,
          color: typeof state.color === "string" ? state.color : "#6b7280",
          isLocal: clientID === awareness.clientID,
          focusing: Boolean(state.focusing),
        });
      });
      // You first, then everyone else in a stable order.
      list.sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.clientID - b.clientID);
      setPeople(list);
    };
    awareness.on("change", update);
    update();
    return () => awareness.off("change", update);
  }, [awareness]);

  if (people.length === 0) return null;
  const others = people.filter((p) => !p.isLocal).length;

  return (
    <div className="active-users" data-testid="active-users" data-count={people.length}>
      <span className="active-users-label">
        {others === 0 ? "Just you" : `${others + 1} people here`}
      </span>
      {people.map((p) => (
        <div
          key={p.clientID}
          className="user-avatar"
          style={{ backgroundColor: p.color, opacity: p.focusing || p.isLocal ? 1 : 0.6 }}
          title={p.isLocal ? `${p.name} (you)` : p.name}
          data-testid="user-avatar"
        >
          {p.name
            .split(" ")
            .map((w) => w[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
      ))}
    </div>
  );
}
