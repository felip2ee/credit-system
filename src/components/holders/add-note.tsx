"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { addHolderNote } from "@/actions/holders";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function AddNote({ holderId }: { holderId: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    if (!content.trim()) return;
    startTransition(async () => {
      await addHolderNote(holderId, content);
      setContent("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <Textarea
        rows={2}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Adicionar anotação..."
      />
      <Button size="sm" onClick={submit} disabled={isPending || !content.trim()}>
        {isPending ? "Salvando..." : "Adicionar"}
      </Button>
    </div>
  );
}
