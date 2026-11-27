"use client";

import { useEffect, useState } from "react";

import { searchHolders, type HolderPick } from "@/actions/consultations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

import { maskDocument } from "./share-link";

export interface ConsultationClient {
  type: EntityKind;
  name: string;
  // Só dígitos. Vai para a ação; a tela mostra sempre a forma mascarada.
  document: string;
  email: string;
  phone: string;
}

const SEARCH_DELAY_MS = 300;
const MIN_TERM = 2;

export interface ClientErrors {
  name?: string;
  document?: string;
}

// Erros do cliente novo ou escolhido, por campo. Objeto vazio = pode seguir.
export function clientErrors(c: ConsultationClient): ClientErrors {
  const errors: ClientErrors = {};
  if (c.name.trim().length < 2) errors.name = "Informe o nome.";
  const valid = c.type === "PF" ? isValidCPF(c.document) : isValidCNPJ(c.document);
  if (!valid) errors.document = c.type === "PF" ? "CPF inválido." : "CNPJ inválido.";
  return errors;
}

// Foco no primeiro campo com erro; sem campo de texto na tela (busca), vai para a caixa de busca.
export function focusFirstInvalid(errors: ClientErrors): void {
  const id = errors.name ? "client-name" : "client-document";
  (document.getElementById(id) ?? document.getElementById("client-search"))?.focus();
}

const SEARCH_ERROR = "Escolha um cliente da lista ou use \u201cNovo cliente\u201d.";

interface ClientStepProps {
  value: ConsultationClient;
  onChange: (c: ConsultationClient) => void;
  // Cliente escolhido na busca: o documento não é digitado nem mostrado inteiro.
  picked: boolean;
  onPicked: (picked: boolean) => void;
  errors?: ClientErrors;
}

export function ClientStep({ value, onChange, picked, onPicked, errors = {} }: ClientStepProps) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<HolderPick[]>([]);
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<"search" | "new">("search");
  const isPf = value.type === "PF";

  useEffect(() => {
    if (picked || mode !== "search" || term.trim().length < MIN_TERM) {
      setResults([]);
      return;
    }
    setSearching(true);
    const id = setTimeout(async () => {
      const found = await searchHolders(term);
      setResults(found.filter((h) => h.type === value.type));
      setSearching(false);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [term, picked, mode, value.type]);

  const set = (patch: Partial<ConsultationClient>) => onChange({ ...value, ...patch });
  const reset = (type: EntityKind) => {
    onPicked(false);
    setTerm("");
    onChange({ type, name: "", document: "", email: "", phone: "" });
  };

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Tipo de cliente" className="grid grid-cols-2 gap-2">
        {(["PF", "PJ"] as const).map((t) => (
          <Button key={t} type="button" variant={value.type === t ? "default" : "outline"} onClick={() => reset(t)} aria-pressed={value.type === t}>
            {t === "PF" ? "Pessoa física" : "Empresa"}
          </Button>
        ))}
      </div>

      {picked ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{value.name}</p>
            <p className="text-sm text-muted-foreground">{maskDocument(value.document)}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => reset(value.type)}>Trocar</Button>
        </div>
      ) : (
        <>
          <div role="group" aria-label="Como informar o cliente" className="flex gap-2">
            <Button type="button" size="sm" variant={mode === "search" ? "secondary" : "ghost"} onClick={() => setMode("search")}>Buscar cadastrado</Button>
            <Button type="button" size="sm" variant={mode === "new" ? "secondary" : "ghost"} onClick={() => setMode("new")}>Novo cliente</Button>
          </div>

          {mode === "search" ? (
            <div className="space-y-2">
              <Field id="client-search" label="Nome ou documento" error={errors.name || errors.document ? SEARCH_ERROR : null}>
                {(a11y) => <Input {...a11y} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Digite ao menos 2 letras ou números" autoComplete="off" />}
              </Field>
              <div aria-live="polite">
                {searching && <p className="text-sm text-muted-foreground">Buscando...</p>}
                {!searching && term.trim().length >= MIN_TERM && results.length === 0 && (
                  <p className="text-sm text-muted-foreground">Nenhum cliente encontrado. Use &ldquo;Novo cliente&rdquo;.</p>
                )}
              </div>
              {results.length > 0 && (
                <ul className="divide-y rounded-lg border">
                  {results.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="flex min-h-14 w-full flex-col items-start px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          onChange({ type: h.type, name: h.name, document: onlyDigits(h.document), email: h.email ?? "", phone: "" });
                          onPicked(true);
                        }}
                      >
                        <span className="font-medium">{h.name}</span>
                        <span className="text-sm text-muted-foreground">{maskDocument(h.document)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Field id="client-name" label={isPf ? "Nome completo" : "Razão social"} error={errors.name}>
                {(a11y) => <Input {...a11y} value={value.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />}
              </Field>
              <Field id="client-document" label={isPf ? "CPF" : "CNPJ"} error={errors.document}>
                {(a11y) => <Input {...a11y} inputMode="numeric" value={value.document} onChange={(e) => set({ document: e.target.value })} placeholder={isPf ? "000.000.000-00" : "00.000.000/0000-00"} autoComplete="off" />}
              </Field>
            </div>
          )}
        </>
      )}

      {(picked || mode === "new") && (
        <div className="space-y-3">
          <Field id="client-email" label="E-mail (opcional)">
            {(a11y) => <Input {...a11y} type="email" value={value.email} onChange={(e) => set({ email: e.target.value })} placeholder="contato@exemplo.com" />}
          </Field>
          <Field id="client-phone" label="Celular (opcional)">
            {(a11y) => <Input {...a11y} type="tel" value={value.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(11) 99999-9999" />}
          </Field>
        </div>
      )}
    </div>
  );
}
