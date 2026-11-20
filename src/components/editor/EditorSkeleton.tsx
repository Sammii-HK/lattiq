/** Placeholder with the editor's shape, shown on the server and until the session opens. */
export default function EditorSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="editor-status-bar">
        <div className="h-6 w-28 animate-pulse rounded-full bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="border-b border-gray-200 p-3 dark:border-gray-700">
          <div className="flex gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-8 w-10 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
            ))}
          </div>
        </div>
        <div className="space-y-3 p-6">
          <div className="h-4 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-4/6 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-3/6 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    </div>
  );
}
