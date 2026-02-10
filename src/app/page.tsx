import Link from "next/link";
import { DOCUMENTS } from "@/lib/constants";

export default function Home() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 text-3xl font-bold text-foreground">Lattiq</h1>
        <p className="mb-8 text-gray-500 dark:text-gray-400">
          Local-first collaborative editor
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {DOCUMENTS.map((doc) => (
            <Link
              key={doc.id}
              href={`/doc/${doc.id}`}
              className="group rounded-lg border border-gray-200 p-5 transition-colors hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-500 dark:hover:bg-gray-800/50"
            >
              <h2 className="mb-1 text-lg font-semibold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400">
                {doc.title}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {doc.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
