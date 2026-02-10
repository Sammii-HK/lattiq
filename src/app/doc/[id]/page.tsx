import { notFound } from "next/navigation";
import { getDocumentById } from "@/lib/constants";
import CollaborativeEditor from "@/components/editor/CollaborativeEditor";
import Link from "next/link";

export default async function DocumentPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const doc = getDocumentById(id);

  if (!doc) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-4">
          <Link
            href="/"
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            &larr; Back
          </Link>
          <h1 className="text-2xl font-bold text-foreground">{doc.title}</h1>
        </div>
        <CollaborativeEditor docId={id} />
      </div>
    </div>
  );
}
