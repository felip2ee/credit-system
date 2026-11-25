"use client";

import { useState, useTransition } from "react";
import { ArrowLeft } from "lucide-react";

import { openCounterOrderAction } from "@/actions/orders";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { cn, formatCurrency } from "@/lib/utils";

import { ClientStep, clientError, type ConsultationClient } from "./client-step";
import { GenerateLinkButton } from "./generate-link-button";
import { maskDocument } from "./share-link";

export interface CatalogChoice {
  code: string;
  name: string;
  price: string;
}

const STEP_LABELS = ["Cliente", "Produto", "Confirmar", "Cobrança"] as const;
const PRODUCT_BY_TYPE = { PF: "dossie_pf", PJ: "dossie_empresarial" } as const;
const EMPTY_CLIENT: ConsultationClient = { type: "PF", name: "", document: "", email: "", phone: "" };

export function NewConsultationFlow({ bureauName, products }: { bureauName: string; products: CatalogChoice[] }) {
  const [step, setStep] = useState(0);
  const [client, setClient] = useState<ConsultationClient>(EMPTY_CLIENT);
  const [picked, setPicked] = useState(false);
  const [productCode, setProductCode] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const options = products.filter((p) => p.code === PRODUCT_BY_TYPE[client.type]);
  const product = products.find((p) => p.code === productCode) ?? null;

  const next = () => {
    const problem = step === 0 ? clientError(client) : step === 1 && !product ? "Escolha o produto." : null;
    setError(problem);
    if (problem) return;
    if (step === 0) setProductCode(options.length === 1 ? options[0].code : null);
    setStep(step + 1);
  };

  const open = () => {
    if (!product) return;
    setError(null);
    startTransition(async () => {
      const res = await openCounterOrderAction({
        productCode: product.code,
        buyerProfileId: null,
        subject: { name: client.name, document: client.document },
        contactEmail: client.email,
        contactPhone: client.phone,
        partners: [],
      });
      if (res.error || !res.id) {
        setError(res.error ?? "Não foi possível abrir a consulta.");
        return;
      }
      setOrderId(res.id);
      setStep(3);
    });
  };

  const restart = () => {
    setClient(EMPTY_CLIENT);
    setPicked(false);
    setProductCode(null);
    setOrderId(null);
    setError(null);
    setStep(0);
  };

  if (products.length === 0) {
    return <StatusBanner tone="attention" title="Nenhum produto à venda." description="Peça ao administrador para ativar um produto no catálogo." />;
  }

  return (
    <div className="space-y-4">
      <div>
        <ol className="flex gap-1.5" aria-hidden>
          {STEP_LABELS.map((label, i) => (
            <li key={label} className={cn("h-1.5 flex-1 rounded-full", i <= step ? "bg-primary" : "bg-muted")} />
          ))}
        </ol>
        <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">
          Passo {step + 1} de {STEP_LABELS.length}: <span className="font-semibold text-foreground">{STEP_LABELS[step]}</span>
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">
            {step === 0 && "Quem será consultado?"}
            {step === 1 && "Qual consulta?"}
            {step === 2 && "Confirme o pedido"}
            {step === 3 && "Consulta aberta"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 0 && <ClientStep value={client} onChange={setClient} picked={picked} onPicked={setPicked} />}

          {step === 1 && (
            <div role="radiogroup" aria-label="Produto" className="space-y-2">
              {options.length === 0 && <p className="text-sm text-muted-foreground">Nenhum produto à venda para este tipo de cliente.</p>}
              {options.map((p) => (
                <button
                  key={p.code}
                  type="button"
                  role="radio"
                  aria-checked={productCode === p.code}
                  onClick={() => setProductCode(p.code)}
                  className={cn(
                    "flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    productCode === p.code ? "border-primary bg-brand-soft" : "border-input hover:bg-muted",
                  )}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="font-bold tabular-nums">{formatCurrency(Number(p.price))}</span>
                </button>
              ))}
            </div>
          )}

          {step === 2 && product && (
            <dl className="space-y-3 text-sm">
              <div><dt className="text-muted-foreground">Cliente</dt><dd className="font-medium">{client.name}</dd></div>
              <div><dt className="text-muted-foreground">Documento</dt><dd className="font-medium">{maskDocument(client.document)}</dd></div>
              <div><dt className="text-muted-foreground">Produto</dt><dd className="font-medium">{product.name}</dd></div>
              <div><dt className="text-muted-foreground">Valor</dt><dd className="text-lg font-bold">{formatCurrency(Number(product.price))}</dd></div>
              <p className="text-muted-foreground">A consulta só roda depois do pagamento e da autorização do cliente.</p>
            </dl>
          )}

          {step === 3 && orderId && product && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {client.name} · {product.name} · {formatCurrency(Number(product.price))}. Gere o link para o cliente pagar por Pix.
              </p>
              <GenerateLinkButton orderId={orderId} bureauName={bureauName} productName={product.name} />
              <Button type="button" variant="ghost" size="sm" onClick={restart}>Nova consulta</Button>
            </div>
          )}

          <div aria-live="polite">{error && <p className="text-sm text-destructive">{error}</p>}</div>

          {step < 3 && (
            <div className="flex gap-2">
              {step > 0 && (
                <Button type="button" variant="outline" onClick={() => { setError(null); setStep(step - 1); }} disabled={isPending}>
                  <ArrowLeft aria-hidden className="h-4 w-4" />
                  Voltar
                </Button>
              )}
              {step < 2 ? (
                <Button type="button" className="flex-1" onClick={next}>Continuar</Button>
              ) : (
                <Button type="button" className="flex-1" onClick={open} disabled={isPending}>{isPending ? "Abrindo..." : "Abrir consulta"}</Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
