"use client";

import LexicalEditor from "./LexicalEditor";

export default function CollaborativeEditor({ docId }: { docId: string }) {
  return <LexicalEditor docId={docId} />;
}
