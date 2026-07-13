"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { createCompanyProcess, processCompanyMember } from "@/actions/company";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";

interface SocioRow {
  cpf: string;
  name: string;
  email: string;
}

const emptySocio = (): SocioRow => ({ cpf: "", name: "", email: "" });

export function CompanyProcessForm() {
  const router = useRouter();

  const [cnpj, setCnpj] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [socios, setSocios] = useState<SocioRow[]>([emptySocio()]);
  const [reuseExisting, setReuseExisting] = useState(true);
  // Origem da autorização SCR das consultas do processo (mesma escolha da consulta
  // avulsa): "internal" = nosso termo; "deps" = autorização gerida pela deps.
  const [scrMode, setScrMode] = useState<"internal" | "deps">("internal");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const updateSocio = (i: number, patch: Partial<SocioRow>) =>
    setSocios((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const addSocio = () => setSocios((prev) => [...prev, emptySocio()]);
  const removeSocio = (i: number) =>
    setSocios((prev) => prev.filter((_, idx) => idx !== i));

  const onSubmit = async () => {
    setError(null);
    if (!isValidCNPJ(onlyDigits(cnpj))) {
      setError("Informe um CNPJ válido.");
      return;
    }
    const filled = socios.filter((s) => onlyDigits(s.cpf).length > 0);
    for (const s of filled) {
      if (!isValidCPF(onlyDigits(s.cpf))) {
        setError(`CPF de sócio inválido: ${s.cpf}`);
        return;
      }
    }

    setRunning(true);
    setProgress(null);
    try {
      const res = await createCompanyProcess({
        cnpj: onlyDigits(cnpj),
        name: name.trim() || undefined,
        email: email.trim() || null,
        socios: filled.map((s) => ({
          cpf: onlyDigits(s.cpf),
          name: s.name.trim() || undefined,
          email: s.email.trim() || null,
        })),
        reuseExisting,
        scrMode,
      });
      if (res.error || !res.batchId || !res.memberQueryIds) {
        setError(res.error ?? "Falha ao criar o processo.");
        setRunning(false);
        return;
      }

      // Processa uma consulta por vez (cada chamada = 1 consulta à deps).
      // O e-mail do titular já está gravado em queries.scr_email.
      const ids = res.memberQueryIds;
      for (let i = 0; i < ids.length; i++) {
        setProgress({ done: i, total: ids.length });
        await processCompanyMember(ids[i], reuseExisting);
      }

      router.push(`/batch/${res.batchId}`);
      router.refresh();
    } catch {
      setError("Falha ao processar as consultas. Abra o processo e use 'Continuar processamento'.");
      setRunning(false);
    }
  };

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="text-lg">Novo processo de empresa</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Empresa */}
        <div className="space-y-4 rounded-md border p-4">
          <p className="text-sm font-medium">Empresa (CNPJ)</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="cnpj">CNPJ</Label>
              <Input
                id="cnpj"
                placeholder="00.000.000/0000-00"
                value={cnpj}
                onChange={(e) => setCnpj(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="razao">Razão social (opcional)</Label>
              <Input
                id="razao"
                placeholder="Nome da empresa"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="company-email">E-mail do titular (registro)</Label>
              <Input
                id="company-email"
                type="email"
                placeholder="contato@empresa.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Sócios */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Sócios (CPF)</p>
            <Button type="button" variant="outline" size="sm" onClick={addSocio}>
              <Plus className="h-4 w-4" />
              Adicionar sócio
            </Button>
          </div>

          {socios.map((s, i) => (
            <div
              key={i}
              className="grid items-end gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
            >
              <div className="space-y-1">
                <Label htmlFor={`cpf-${i}`}>CPF</Label>
                <Input
                  id={`cpf-${i}`}
                  placeholder="000.000.000-00"
                  value={s.cpf}
                  onChange={(e) => updateSocio(i, { cpf: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`nome-${i}`}>Nome (opcional)</Label>
                <Input
                  id={`nome-${i}`}
                  placeholder="Nome do sócio"
                  value={s.name}
                  onChange={(e) => updateSocio(i, { name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`email-${i}`}>E-mail (opcional)</Label>
                <Input
                  id={`email-${i}`}
                  type="email"
                  placeholder="socio@email.com"
                  value={s.email}
                  onChange={(e) => updateSocio(i, { email: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeSocio(i)}
                disabled={socios.length === 1}
                aria-label="Remover sócio"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Digite o CPF completo de cada sócio — o bureau mascara o CPF no quadro
            societário, então não dá para puxar automaticamente.
          </p>
        </div>

        {/* Origem da autorização SCR (vale para todas as consultas do processo) */}
        <div className="space-y-2">
          <Label>Autorização SCR</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setScrMode("internal")}
              aria-pressed={scrMode === "internal"}
              className={
                "rounded-md border p-3 text-left text-sm transition-colors " +
                (scrMode === "internal"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "hover:bg-muted/50")
              }
            >
              <span className="font-medium">Autorização própria</span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Nosso termo por e-mail + código. Cada consulta só roda se o titular
                já autorizou no nosso sistema.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setScrMode("deps")}
              aria-pressed={scrMode === "deps"}
              className={
                "rounded-md border p-3 text-left text-sm transition-colors " +
                (scrMode === "deps"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "hover:bg-muted/50")
              }
            >
              <span className="font-medium">Autorização da deps</span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                A deps verifica a autorização dela. Não usa nosso termo; sem
                autorização, a consulta fica pendente.
              </p>
            </button>
          </div>
        </div>

        {/* Reutilizar dados existentes */}
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3">
          <input
            id="reuse-existing"
            type="checkbox"
            checked={reuseExisting}
            onChange={(e) => setReuseExisting(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
          />
          <div className="space-y-0.5">
            <Label htmlFor="reuse-existing" className="cursor-pointer">
              Reutilizar dados existentes
            </Label>
            <p className="text-xs text-muted-foreground">
              Reaproveita consultas já feitas na deps, sem gerar nova cobrança.
              Desmarque para forçar consultas novas (com custo).
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button onClick={onSubmit} disabled={running}>
          {running ? "Processando consultas..." : "Iniciar processo"}
        </Button>
        {running && (
          <p className="text-xs text-muted-foreground">
            {progress
              ? `Consultando ${progress.done + 1} de ${progress.total}...`
              : "Criando o processo..."}{" "}
            As consultas rodam uma a uma; isso pode levar alguns segundos.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
