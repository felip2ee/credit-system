"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauStatus, updateBureau } from "@/actions/bureaus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BureauSummary } from "@/lib/bureaus/queries";
import { StatusBanner } from "@/components/ui/status-banner";
import { SLUG_PATTERN } from "@/lib/validators/register";

export function BureauEditForm({ bureau }: { bureau: BureauSummary }) {
  const router = useRouter();
  const [name, setName] = useState(bureau.name);
  const [slug, setSlug] = useState(bureau.slug);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const slugInvalid = !SLUG_PATTERN.test(slug);
  const isActive = bureau.status === "active";

  const run = (work: () => Promise<{ error: string | null }>) => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (slugInvalid) return;
        run(() => updateBureau({ id: bureau.id, name, ...(slug !== bureau.slug && { slug }) }));
      }}
      className="max-w-xl space-y-4"
    >
      <div className="flex items-center gap-2">
        <Badge variant={isActive ? "success" : "muted"}>{isActive ? "Ativo" : "Inativo"}</Badge>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => run(() => setBureauStatus(bureau.id, isActive ? "inactive" : "active"))}
        >
          {isActive ? "Desativar" : "Ativar"}
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="bureau-name">Nome do Bureau</Label>
        <Input id="bureau-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="bureau-slug">Endereço público (slug)</Label>
        <Input
          id="bureau-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value.trim().toLowerCase())}
          aria-invalid={slugInvalid}
          aria-describedby="bureau-slug-help"
        />
        <p id="bureau-slug-help" className={slugInvalid ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {slugInvalid
            ? "Use de 3 a 40 letras minúsculas, números ou hífen."
            : "O link antigo continua funcionando e redireciona para o novo."}
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <StatusBanner tone="success" title="Salvo." />}
      <Button type="submit" disabled={isPending || slugInvalid}>
        {isPending ? "Salvando..." : "Salvar"}
      </Button>
    </form>
  );
}
