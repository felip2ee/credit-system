"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauStatus, updateBureau } from "@/actions/bureaus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { BureauSummary } from "@/lib/bureaus/queries";
import { StatusBanner } from "@/components/ui/status-banner";
import { bureauUpdateSchema } from "@/lib/validators/bureau";
import { SLUG_PATTERN } from "@/lib/validators/register";

const NAME_REQUIRED = "Informe o nome do Bureau.";

export function BureauEditForm({ bureau }: { bureau: BureauSummary }) {
  const router = useRouter();
  const [name, setName] = useState(bureau.name);
  const [slug, setSlug] = useState(bureau.slug);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nameError = bureauUpdateSchema.shape.name.safeParse(name).success ? null : NAME_REQUIRED;
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

  const changeStatus = () => {
    setConfirmOpen(false);
    run(() => setBureauStatus(bureau.id, isActive ? "inactive" : "active"));
  };

  return (
    <div className="max-w-xl space-y-4">
      <div className="space-y-2 rounded-card border border-border p-3">
        <div className="flex items-center gap-2">
          <Badge variant={isActive ? "success" : "muted"}>{isActive ? "Ativo" : "Inativo"}</Badge>
          <span className="text-sm font-bold">{isActive ? "Bureau ativo" : "Bureau inativo"}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {isActive
            ? "Desativar bloqueia o acesso de todos os usuários do Bureau e tira do ar a página pública. Nada é apagado."
            : "Ativar libera de novo o acesso dos usuários do Bureau e a página pública."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => (isActive ? setConfirmOpen(true) : changeStatus())}
        >
          {isActive ? "Desativar Bureau" : "Ativar Bureau"}
        </Button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (slugInvalid || nameError) return;
          run(() => updateBureau({ id: bureau.id, name, ...(slug !== bureau.slug && { slug }) }));
        }}
        noValidate
        className="space-y-4"
      >
        <Field id="bureau-name" label="Nome do Bureau" error={nameError}>
          {(a11y) => <Input {...a11y} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          id="bureau-slug"
          label="Endereço público (slug)"
          helper="O link antigo continua funcionando e leva ao novo. O endereço antigo não pode ser usado por outro Bureau."
          error={slugInvalid ? "Use de 3 a 40 letras minúsculas, números ou hífen." : null}
        >
          {(a11y) => <Input {...a11y} value={slug} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} />}
        </Field>
        {saved && <StatusBanner tone="success" title="Salvo." />}
        <Button type="submit" disabled={isPending || slugInvalid || nameError !== null}>
          {isPending ? "Salvando..." : "Salvar"}
        </Button>
      </form>
      {error && <StatusBanner tone="danger" title={error} />}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Desativar o Bureau?" role="alertdialog">
        <ul className="list-disc space-y-1 pl-5 text-base">
          <li>Administradores, equipe e clientes do Bureau são recusados no próximo acesso, e as sessões abertas caem.</li>
          <li>A página pública do Bureau deixa de abrir.</li>
          <li>Nada é apagado. Você pode ativar o Bureau de novo.</li>
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" autoFocus onClick={() => setConfirmOpen(false)}>
            Cancelar
          </Button>
          <Button type="button" variant="destructive" onClick={changeStatus}>
            Desativar Bureau
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
