"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  findRecentConsultation,
  runConsultation,
  searchClients,
  type ClientPick,
} from "@/actions/consultations";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCNPJ, formatCPF } from "@/lib/utils";

export function ConsultationForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [term, setTerm] = useState("");
  const [results, setResults] = useState<ClientPick[]>([]);
  const [selected, setSelected] = useState<ClientPick | null>(null);
  const [observations, setObservations] = useState("");
  // E-mail do titular: usado para (re)enviar a autorização SCR caso ainda não
  // haja aceite. Pré-preenchido com o do cadastro. Opcional.
  const [scrEmail, setScrEmail] = useState("");
  // Reaproveita dados já existentes na deps (não gera nova cobrança). Default ligado.
  const [reuseExisting, setReuseExisting] = useState(true);
  // Origem da autorização SCR: "internal" = nosso termo (e-mail + código);
  // "deps" = autorização gerida pela própria deps. Default "internal".
  const [scrMode, setScrMode] = useState<"internal" | "deps">("internal");

  const [error, setError] = useState<string | null>(null);
  // Resultado "aguardando autorização SCR" (HTTP 400 da deps).
  const [pending, setPending] = useState<string | null>(null);
  const [recentPrompt, setRecentPrompt] = useState<{
    queryId: string;
    consultedAt: string;
  } | null>(null);

  // Busca de clientes (debounced) enquanto não há selecionado.
  useEffect(() => {
    if (selected) return;
    const id = setTimeout(async () => {
      const r = await searchClients(term);
      setResults(r);
    }, 300);
    return () => clearTimeout(id);
  }, [term, selected]);

  const fmtDoc = (c: ClientPick) =>
    c.document
      ? c.type === "PJ"
        ? formatCNPJ(c.document)
        : formatCPF(c.document)
      : "—";

  const execute = () => {
    if (!selected) return;
    setError(null);
    setPending(null);
    startTransition(async () => {
      const result = await runConsultation({
        crmClientId: selected.id,
        type: selected.type,
        document: selected.document ?? "",
        documentName: selected.name,
        observations,
        email: scrEmail.trim() || null,
        reuseExisting,
        scrMode,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.status === "pending_scr") {
        setPending(
          result.message ??
            "Autorização SCR pendente. Conceda a autorização no portal da deps e clique em Tentar novamente."
        );
        router.refresh();
        return;
      }
      router.push(`/consultations/${result.queryId}`);
      router.refresh();
    });
  };

  const onConsult = () => {
    if (!selected) {
      setError("Selecione um cliente.");
      return;
    }
    if (!selected.document) {
      setError("O cliente não possui documento cadastrado.");
      return;
    }
    setError(null);
    setPending(null);
    setRecentPrompt(null);
    const document = selected.document;
    startTransition(async () => {
      const recent = await findRecentConsultation(document);
      if (recent.exists && recent.queryId && recent.consultedAt) {
        setRecentPrompt({ queryId: recent.queryId, consultedAt: recent.consultedAt });
        return;
      }
      execute();
    });
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-lg">Nova consulta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Cliente */}
        <div className="space-y-2">
          <Label>Cliente</Label>
          {selected ? (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="text-sm">
                <span className="font-medium">{selected.name}</span>
                <span className="ml-2 text-muted-foreground">
                  {selected.type} · {fmtDoc(selected)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelected(null);
                  setError(null);
                  setPending(null);
                  setScrEmail("");
                }}
              >
                Trocar
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                placeholder="Buscar cliente por nome, CPF ou CNPJ..."
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
              {results.length > 0 && (
                <ul className="max-h-56 overflow-auto rounded-md border">
                  {results.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(c);
                          setScrEmail(c.email ?? "");
                          setResults([]);
                          setTerm("");
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-medium">{c.name}</span>
                        <span className="text-muted-foreground">
                          {c.type} · {fmtDoc(c)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Não encontrou?{" "}
                <Link href="/clients/new" className="underline">
                  Cadastrar novo cliente
                </Link>
              </p>
            </div>
          )}
        </div>

        {/* Produto (definido pelo tipo) */}
        {selected && (
          <div className="space-y-1">
            <Label>Produto</Label>
            <p className="text-sm text-muted-foreground">
              {selected.type === "PF" ? "Smart PF 002" : "Smart PJ 010"}
            </p>
          </div>
        )}

        {/* Origem da autorização SCR */}
        {selected && (
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
                  Nosso termo por e-mail + código. Só consulta se o titular já
                  autorizou no nosso sistema.
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
                  A deps verifica a autorização dela. Não usa nosso termo; se não
                  houver autorização, a consulta não é feita.
                </p>
              </button>
            </div>
          </div>
        )}

        {/* E-mail do titular (autorização SCR) */}
        {selected && (
          <div className="space-y-1">
            <Label htmlFor="scr-email">E-mail do titular</Label>
            <Input
              id="scr-email"
              type="email"
              placeholder="titular@email.com"
              value={scrEmail}
              onChange={(e) => setScrEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Fica registrado no cadastro do titular e é usado para enviar o termo
              de autorização SCR quando necessário. Opcional.
            </p>
          </div>
        )}

        {/* Observações */}
        <div className="space-y-2">
          <Label htmlFor="obs">Observações internas</Label>
          <textarea
            id="obs"
            rows={2}
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        {/* Reutilizar dados existentes (evita nova cobrança na deps) */}
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
              Reaproveita uma consulta já feita na deps, sem gerar nova cobrança.
              Desmarque para forçar uma consulta nova (com custo).
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Popup de consulta recente */}
        {recentPrompt && (
          <div className="space-y-3 rounded-md border border-sky-300 bg-sky-50 p-4">
            <p className="text-sm font-medium text-sky-900">
              Já existe consulta recente para este documento
            </p>
            <p className="text-sm text-sky-800">
              Realizada em{" "}
              {new Date(recentPrompt.consultedAt).toLocaleDateString("pt-BR")}.
              Realizar nova consulta gerará uma nova cobrança na deps.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  router.push(`/consultations/${recentPrompt.queryId}`);
                  router.refresh();
                }}
                disabled={isPending}
              >
                Ver consulta existente
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setRecentPrompt(null);
                  execute();
                }}
                disabled={isPending}
              >
                Realizar nova consulta
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRecentPrompt(null)}
                disabled={isPending}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {/* Aguardando autorização SCR (HTTP 400 da deps) */}
        {pending && (
          <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              Autorização SCR pendente
            </p>
            <p className="text-sm text-amber-800">{pending}</p>
            <p className="text-sm text-amber-800">
              A consulta poderá ser concluída após a autorização ser concedida.
              Acompanhe em Autorizações SCR.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" asChild>
                <Link href="/scr">Ver Autorizações SCR</Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPending(null)}
                disabled={isPending}
              >
                Fechar
              </Button>
            </div>
          </div>
        )}

        {!recentPrompt && !pending && (
          <Button onClick={onConsult} disabled={isPending || !selected}>
            {isPending ? "Processando..." : "Consultar"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
