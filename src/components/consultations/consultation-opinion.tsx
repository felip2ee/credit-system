"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Loader2, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";

import { generateOpinion } from "@/actions/ai";
import { OpenOpportunityButton } from "@/components/opportunities/open-opportunity-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Parecer } from "@/types/ai";

export interface OpinionData {
  status: string; // generating | completed | error
  aptitude_status: string; // apt | apt_with_caveats | inapt | pending
  generation_error: string | null;
  report_markdown: string | null;
  full_report: Parecer | null;
  model_used: string | null;
  generated_at: string | null;
}

interface Props {
  queryId: string;
  report: OpinionData | null;
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

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h2 className="mt-6 text-lg font-semibold text-foreground">{children}</h2>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 border-b pb-1 text-base font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 text-sm font-semibold text-foreground">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
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

export function ConsultationOpinion({ queryId, report }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(report?.generation_error ?? null);
  const autoTriggered = useRef(false);

  const hasReport = report?.status === "completed" && !!report.full_report;
  const isError = report?.status === "error" || (!!error && !isPending);

  const run = (force: boolean) => {
    setError(null);
    startTransition(async () => {
      const res = await generateOpinion(queryId, force);
      if (res.error) setError(res.error);
      router.refresh();
    });
  };

  // Disparo automático na primeira abertura, quando ainda não há parecer.
  useEffect(() => {
    if (autoTriggered.current) return;
    if (!hasReport && !isError && !isPending) {
      autoTriggered.current = true;
      run(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Estado: gerando ──
  if (!hasReport && !isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5" /> Parecer de IA
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Gerando parecer técnico... isso pode levar alguns segundos.
        </CardContent>
      </Card>
    );
  }

  // ── Estado: erro ──
  if (!hasReport && isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="h-5 w-5" /> Parecer de IA
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

  // ── Estado: parecer pronto ──
  const parecer = report!.full_report!;
  const apt = APTITUDE[report!.aptitude_status] ?? APTITUDE.pending;

  const notas = parecer.notas;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5" /> Parecer de IA
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
        {/* Resumo executivo */}
        <p className="text-sm text-muted-foreground">{parecer.resumo_executivo}</p>

        {/* CTA: abrir oportunidade quando apto / apto com ressalvas */}
        {(report!.aptitude_status === "apt" ||
          report!.aptitude_status === "apt_with_caveats") && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm font-medium">
              Cliente apto — avance para a intermediação.
            </p>
            <OpenOpportunityButton queryId={queryId} />
          </div>
        )}

        {/* Notas */}
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

        {/* Top oportunidades imediatas */}
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

        {/* Relatório completo */}
        {report!.report_markdown && (
          <details className="rounded-md border">
            <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">
              Ver parecer técnico completo (23 seções)
            </summary>
            <div className="border-t px-4 py-3 text-sm text-muted-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {report!.report_markdown}
              </ReactMarkdown>
            </div>
          </details>
        )}

        {/* Rodapé: disclaimer + metadados */}
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
