"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { addOpportunityNote } from "@/actions/opportunities";
import { Button } from "@/components/ui/button";

export function AddOpportunityNote({
  opportunityId,
}: {
  opportunityId: string;
}) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    if (!content.trim()) return;
    startTransition(async () => {
      await addOpportunityNote(opportunityId, content);
      setContent("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <textarea
        rows={2}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Adicionar anotação..."
        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
      <Button size="sm" onClick={submit} disabled={isPending || !content.trim()}>
        {isPending ? "Salvando..." : "Adicionar"}
      </Button>
    </div>
  );
}
