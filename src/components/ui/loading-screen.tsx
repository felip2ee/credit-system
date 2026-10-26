import { Skeleton } from "@/components/ui/skeleton";

export function LoadingScreen() {
  return (
    <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <span className="sr-only">Carregando...</span>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
