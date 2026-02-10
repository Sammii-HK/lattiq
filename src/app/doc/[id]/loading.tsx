export default function Loading() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="border-b border-gray-200 p-3 dark:border-gray-700">
            <div className="flex gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-8 w-10 animate-pulse rounded bg-gray-200 dark:bg-gray-700"
                />
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
    </div>
  );
}
