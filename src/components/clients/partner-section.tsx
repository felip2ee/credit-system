"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { linkPartner } from "@/actions/clients";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCPF } from "@/lib/utils";

export interface PartnerItem {
  id: string;
  name: string;
  document: string | null;
  percentage: number | null;
  role: string | null;
}

export function PartnerSection({
  pjClientId,
  partners,
}: {
  pjClientId: string;
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

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await linkPartner(pjClientId, {
        cpf: form.cpf,
        name: form.name,
        percentage: form.percentage ? Number(form.percentage) : null,
        role: form.role || null,
      });
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
                <Link href={`/clients/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                <span className="ml-2 text-muted-foreground">
                  {p.document ? formatCPF(p.document) : ""}
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
            <div className="space-y-1">
              <Label htmlFor="p-cpf">CPF do sócio</Label>
              <Input
                id="p-cpf"
                value={form.cpf}
                onChange={(e) =>
                  setForm({ ...form, cpf: formatCPF(e.target.value) })
                }
                placeholder="000.000.000-00"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-name">Nome</Label>
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-role">Cargo</Label>
              <Input
                id="p-role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                placeholder="Administrador, Sócio..."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-pct">Participação (%)</Label>
              <Input
                id="p-pct"
                inputMode="numeric"
                value={form.percentage}
                onChange={(e) =>
                  setForm({ ...form, percentage: e.target.value })
                }
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
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
