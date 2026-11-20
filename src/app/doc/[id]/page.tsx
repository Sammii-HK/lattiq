import { notFound } from "next/navigation";
import { getDocumentById } from "@/lib/constants";
import CollaborativeEditor from "@/components/editor/CollaborativeEditor";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default async function DocumentPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const doc = getDocumentById(id);

  if (!doc) {
    notFound();
  }

  return (
    <div className="lattiq-shell writing-room">
      <div className="writing-room-inner">
        <div className="writing-room-heading">
          <Link
            href="/"
            className="quiet-link"
          >
            <ArrowLeft size={16} aria-hidden="true" /> All documents
          </Link>
          <h1 className="writing-room-title">{doc.title}</h1>
        </div>
        <CollaborativeEditor docId={id} />
        <p className="writing-room-footnote">A writing room by Lattiq. Your connection and saving state are shown above the page.</p>
      </div>
    </div>
  );
}
