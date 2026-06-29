"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { reprocessQuery } from "@/actions/consultations";
import { Button } from "@/components/ui/button";

export function ReprocessButton({
  queryId,
  size = "sm",
}: {
  queryId: string;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      await reprocessQuery(queryId);
      router.refresh();
    });
  };

  return (
    <Button variant="outline" size={size} onClick={run} disabled={isPending}>
      <RefreshCw className="h-4 w-4" />
      {isPending ? "Reprocessando..." : "Reprocessar"}
    </Button>
  );
}
