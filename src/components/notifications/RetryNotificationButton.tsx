"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { retryNotificationAction } from "@/actions/notifications";
import { Button } from "@/components/ui/button";

export function RetryNotificationButton({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const retry = () => {
    setError(null);
    startTransition(async () => {
      const res = await retryNotificationAction({ id });
      if (res.error) setError(res.error);
      router.refresh();
    });
  };

  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" onClick={retry} disabled={isPending} aria-label="Tentar de novo o envio">
        {isPending ? "Enviando..." : "Tentar de novo"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
