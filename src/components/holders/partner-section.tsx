"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { linkPartner } from "@/actions/holders";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { linkPartnerSchema } from "@/lib/validators/holder";
import { formatCPF } from "@/lib/utils";
import { maskDocument } from "@/lib/mask-document";
import type { EntityKind } from "@/types/app";

export interface PartnerItem {
  id: string;
  name: string;
  type: EntityKind;
  document: string | null;
  percentage: number | null;
  role: string | null;
}

const FIELD_IDS = { cpf: "p-cpf", name: "p-name", percentage: "p-pct" } as const;

export function PartnerSection({
  companyId,
  partners,
}: {
  companyId: string;
  partners: PartnerItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    cpf: "",
    name: "",
    percentage: "",
    role: "",
  });

  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"cpf" | "name" | "percentage", string>>>({});

  const submit = () => {
    setError(null);
    const input = {
      cpf: form.cpf,
      name: form.name,
      percentage: form.percentage.trim() ? Number(form.percentage.replace(",", ".")) : null,
      role: form.role || null,
    };
    // Mesma regra do servidor (linkPartnerSchema); o servidor valida de novo.
    const parsed = linkPartnerSchema.safeParse(input);
    if (!parsed.success) {
      const next: typeof fieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === "cpf" || key === "name" || key === "percentage") && !next[key]) next[key] = issue.message;
      }
      setFieldErrors(next);
      const first = (["cpf", "name", "percentage"] as const).find((k) => next[k]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      const result = await linkPartner(companyId, input);
      if (result.error) {
        setError(result.error);
        return;
      }
      setForm({ cpf: "", name: "", percentage: "", role: "" });
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {partners.length > 0 ? (
        <ul className="space-y-2">
          {partners.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between rounded-md border p-3 text-sm"
            >
              <div>
                <Link href={`/holders/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                <span className="ml-2 text-muted-foreground">
                  {maskDocument(p.type, p.document ?? "")}
                  {p.role ? ` · ${p.role}` : ""}
                  {p.percentage != null ? ` · ${p.percentage}%` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nenhum sócio vinculado.</p>
      )}

      {open ? (
        <div className="space-y-3 rounded-md border p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="p-cpf" label="CPF do sócio" error={fieldErrors.cpf}>
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="numeric"
                  value={form.cpf}
                  onChange={(e) => setForm({ ...form, cpf: formatCPF(e.target.value) })}
                  placeholder="000.000.000-00"
                />
              )}
            </Field>
            <Field id="p-name" label="Nome" error={fieldErrors.name}>
              {(a11y) => <Input {...a11y} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
            </Field>
            <Field id="p-role" label="Cargo" helper="Opcional.">
              {(a11y) => (
                <Input
                  {...a11y}
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  placeholder="Administrador, Sócio..."
                />
              )}
            </Field>
            <Field id="p-pct" label="Participação (%)" helper="Opcional. De 0 a 100." error={fieldErrors.percentage}>
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="decimal"
                  value={form.percentage}
                  onChange={(e) => setForm({ ...form, percentage: e.target.value })}
                />
              )}
            </Field>
          </div>
          {error && (
            <p role="alert" className="text-sm font-bold text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={submit} disabled={isPending}>
              {isPending ? "Vinculando..." : "Vincular sócio"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
                setFieldErrors({});
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Vincular sócio
        </Button>
      )}
    </div>
  );
}
