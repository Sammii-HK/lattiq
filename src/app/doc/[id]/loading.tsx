import EditorSkeleton from "@/components/editor/EditorSkeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <EditorSkeleton />
      </div>
    </div>
  );
}
