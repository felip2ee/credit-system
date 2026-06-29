"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";

import { generateCompanyReport } from "@/actions/company";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownReport } from "@/components/shared/markdown-report";
import { cn } from "@/lib/utils";
import type { Parecer } from "@/types/ai";

export interface CompanyReportData {
  status: string; // generating | completed | error
  aptitude_status: string; // apt | apt_with_caveats | inapt | pending
  generation_error: string | null;
  report_markdown: string | null;
  full_report: Parecer | null;
  model_used: string | null;
  generated_at: string | null;
}

interface Props {
  batchId: string;
  // Há pelo menos a consulta da empresa concluída? Sem isso não dá para gerar.
  canGenerate: boolean;
  report: CompanyReportData | null;
}

const APTITUDE: Record<
  string,
  { label: string; variant: "success" | "secondary" | "destructive" | "muted" }
> = {
  apt: { label: "Apto", variant: "success" },
  apt_with_caveats: { label: "Apto com ressalvas", variant: "secondary" },
  inapt: { label: "Inapto", variant: "destructive" },
  pending: { label: "Pendente", variant: "muted" },
};

function NotaPill({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 7
      ? "bg-emerald-100 text-emerald-800"
      : value >= 5
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";
  return (
    <div className="flex flex-col items-center rounded-md border p-2">
      <span className={cn("rounded-full px-2 py-0.5 text-sm font-bold", tone)}>
        {value.toFixed(1)}
      </span>
      <span className="mt-1 text-center text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

export function CompanyReportPanel({ batchId, canGenerate, report }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(report?.generation_error ?? null);

  const hasReport = report?.status === "completed" && !!report.full_report;
  const isError = report?.status === "error" || (!!error && !isPending);

  const run = (force: boolean) => {
    setError(null);
    startTransition(async () => {
      const res = await generateCompanyReport(batchId, force);
      if (res.error) setError(res.error);
      router.refresh();
    });
  };

  // ── Ainda não gerado ──
  if (!hasReport && !isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5" /> Parecer consolidado do quadro societário
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isPending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Gerando parecer consolidado... isso pode levar alguns segundos.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Analisa a empresa e todos os sócios já consultados em conjunto.
              </p>
              <Button onClick={() => run(false)} disabled={isPending || !canGenerate}>
                <Sparkles className="h-4 w-4" />
                Gerar parecer consolidado
              </Button>
              {!canGenerate && (
                <p className="text-xs text-muted-foreground">
                  Conclua ao menos a consulta da empresa (CNPJ) para gerar o parecer.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Erro ──
  if (!hasReport && isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5" /> Parecer consolidado do quadro societário
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <TriangleAlert className="h-4 w-4" />
            {error ?? report?.generation_error ?? "Falha ao gerar o parecer."}
          </p>
          <Button variant="outline" size="sm" onClick={() => run(true)} disabled={isPending}>
            <RefreshCw className="h-4 w-4" />
            {isPending ? "Gerando..." : "Tentar novamente"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Pronto ──
  const parecer = report!.full_report!;
  const apt = APTITUDE[report!.aptitude_status] ?? APTITUDE.pending;
  const notas = parecer.notas;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5" /> Parecer consolidado do quadro societário
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={apt.variant}>{apt.label}</Badge>
          <Badge variant="outline">{parecer.classificacao_perfil}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run(true)}
            disabled={isPending}
            title="Regenerar parecer"
          >
            <RefreshCw className={cn("h-4 w-4", isPending && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">{parecer.resumo_executivo}</p>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
          <NotaPill label="Cadastro" value={notas.cadastro} />
          <NotaPill label="Score" value={notas.score} />
          <NotaPill label="SCR" value={notas.scr} />
          <NotaPill label="Relac." value={notas.relacionamento_bancario} />
          <NotaPill label="Capac." value={notas.capacidade_financeira} />
          <NotaPill label="Garantias" value={notas.garantias} />
          <NotaPill label="Risco" value={notas.risco} />
          <NotaPill label="Aprovação" value={notas.potencial_aprovacao} />
          <NotaPill label="FINAL" value={notas.final} />
        </div>

        {parecer.top_oportunidades_imediatas.length > 0 && (
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4" /> Oportunidades imediatas
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {parecer.top_oportunidades_imediatas.map((o, i) => (
                <div key={i} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{o.linha}</span>
                    <Badge variant="muted">{o.probabilidade_aprovacao_estimada}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{o.observacao}</p>
                  {o.limite_potencial && o.limite_potencial !== "Não informado" && (
                    <p className="mt-1 text-xs">Limite potencial: {o.limite_potencial}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {report!.report_markdown && (
          <details className="rounded-md border" open>
            <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">
              Ver parecer técnico completo
            </summary>
            <div className="border-t px-4 py-3 text-sm text-muted-foreground">
              <MarkdownReport>{report!.report_markdown}</MarkdownReport>
            </div>
          </details>
        )}

        <div className="space-y-1 border-t pt-3 text-[11px] text-muted-foreground">
          <p>{parecer.disclaimer}</p>
          {report!.model_used && (
            <p>
              Gerado por {report!.model_used}
              {report!.generated_at
                ? ` · ${new Date(report!.generated_at).toLocaleString("pt-BR")}`
                : ""}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
