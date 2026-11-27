"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { openCounterOrderAction } from "@/actions/orders";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScreenHeader } from "@/components/ui/screen-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { isStepSettled, STEP_CLICK_GUARD_MS } from "@/lib/ui/step-guard";
import { formatCurrency } from "@/lib/utils";

import { ClientStep, clientErrors, focusFirstInvalid, type ClientErrors, type ConsultationClient } from "./client-step";
import { GenerateLinkButton } from "./generate-link-button";
import { maskDocument } from "./share-link";

export interface CatalogChoice {
  code: string;
  name: string;
  price: string;
}

const STEPS = [
  { label: "Cliente", title: "Quem será consultado?", after: "Você escolhe a consulta." },
  { label: "Produto", title: "Qual consulta?", after: "Você confere o pedido e abre a consulta." },
  {
    label: "Confirmar",
    title: "Confirme o pedido",
    after: "A consulta fica aguardando pagamento. Você gera o link para o cliente pagar por Pix.",
  },
  {
    label: "Cobrança",
    title: "Consulta aberta",
    after: "O cliente paga e autoriza a consulta. Ela só roda depois do pagamento e da autorização.",
  },
] as const;
const LAST_STEP = STEPS.length - 1;
const CONFIRM_STEP = 2;
const EXIT_HREF = "/admin";
const COMPANY_ONLY_NOTE = "Este pedido inclui só a empresa. Para incluir sócios, use o painel do Bureau.";
const PRODUCT_BY_TYPE = { PF: "dossie_pf", PJ: "dossie_empresarial" } as const;
const EMPTY_CLIENT: ConsultationClient = { type: "PF", name: "", document: "", email: "", phone: "" };

// Sangra até a borda do `main` do app admin (p-4, md:p-6) para o cabeçalho fixo ocupar a largura toda.
const BLEED = "-mx-4 -mt-4 md:-mx-6 md:-mt-6";

// Duplo clique: só o primeiro clique age. Teclado (detail 0) e clique simples (detail 1) sempre passam.
const ignoreRepeatedClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  if (event.detail > 1) event.preventDefault();
};

export function NewConsultationFlow({ bureauName, products }: { bureauName: string; products: CatalogChoice[] }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [client, setClient] = useState<ConsultationClient>(EMPTY_CLIENT);
  const [picked, setPicked] = useState(false);
  const [productCode, setProductCode] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientFieldErrors, setClientFieldErrors] = useState<ClientErrors>({});
  const [leaveOpen, setLeaveOpen] = useState(false);
  // A consulta só abre depois que a confirmação foi mostrada (e passou o tempo de guarda).
  const [confirmReady, setConfirmReady] = useState(false);
  const [isPending, startTransition] = useTransition();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(0);
  const stepChangedAt = useRef(0);
  const submitting = useRef(false);

  const options = products.filter((p) => p.code === PRODUCT_BY_TYPE[client.type]);
  const product = products.find((p) => p.code === productCode) ?? null;
  const hasTypedData = picked || [client.name, client.document, client.email, client.phone].some((v) => v.trim() !== "");
  const current = STEPS[step];

  // Ao trocar de passo o foco vai para o título, para o leitor de tela anunciar onde está. Não na abertura
  // (o StrictMode roda o efeito duas vezes: comparar com o passo já mostrado evita o foco falso).
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stepChangedAt.current = Date.now();
    titleRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (step !== CONFIRM_STEP) {
      setConfirmReady(false);
      return;
    }
    const timer = setTimeout(() => setConfirmReady(true), STEP_CLICK_GUARD_MS);
    return () => clearTimeout(timer);
  }, [step]);

  const requestExit = () => {
    if (hasTypedData) setLeaveOpen(true);
    else router.push(EXIT_HREF);
  };

  const goBack = () => {
    setError(null);
    setClientFieldErrors({});
    if (step === 0) requestExit();
    else setStep(step - 1);
  };

  const next = () => {
    if (step === 0) {
      const errors = clientErrors(client);
      setClientFieldErrors(errors);
      if (errors.name || errors.document) {
        focusFirstInvalid(errors);
        return;
      }
    }
    if (step === 1 && !product) {
      setError("Escolha o produto.");
      return;
    }
    setError(null);
    if (step === 0) setProductCode(options.length === 1 ? options[0].code : null);
    setStep(step + 1);
  };

  const open = () => {
    if (!product || submitting.current) return;
    // Dinheiro: um clique que ainda faz parte do duplo clique do passo anterior não abre a consulta.
    if (!confirmReady || !isStepSettled(stepChangedAt.current, Date.now())) return;
    submitting.current = true;
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
        submitting.current = false;
        setError(res.error ?? "Não foi possível abrir a consulta.");
        return;
      }
      setOrderId(res.id);
      setStep(LAST_STEP);
    });
  };

  const restart = () => {
    submitting.current = false;
    setClient(EMPTY_CLIENT);
    setPicked(false);
    setProductCode(null);
    setOrderId(null);
    setError(null);
    setClientFieldErrors({});
    setStep(0);
  };

  if (products.length === 0) {
    return <StatusBanner tone="attention" title="Nenhum produto à venda." description="Peça ao administrador para ativar um produto no catálogo." />;
  }

  const created = step === LAST_STEP;

  return (
    <div className="space-y-6">
      <ScreenHeader
        className={BLEED}
        title="Nova consulta"
        // Com a consulta já aberta não há volta: voltar abriria uma segunda.
        onBack={created ? undefined : goBack}
        onClose={created ? undefined : requestExit}
        closeHref={created ? EXIT_HREF : undefined}
        step={{ current: step + 1, total: STEPS.length, label: current.label }}
      />

      <section key={step} className="mx-auto w-full max-w-2xl space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200 [&_input]:scroll-mt-20">
        <h2 ref={titleRef} tabIndex={-1} className="text-xl font-bold focus:outline-none">
          <span className="sr-only">
            Passo {step + 1} de {STEPS.length}:{" "}
          </span>
          {current.title}
        </h2>

        {step === 0 && <ClientStep value={client} onChange={setClient} picked={picked} onPicked={setPicked} errors={clientFieldErrors} />}

        {step === 1 && (
          <>
            {options.length === 0 && <p className="text-base text-muted-foreground">Nenhum produto à venda para este tipo de cliente.</p>}
            <RadioGroup aria-label="Produto" value={productCode ?? ""} onValueChange={setProductCode}>
              {options.map((p) => (
                <div key={p.code} className="min-w-0 rounded-card border border-input has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-brand-soft">
                  <label htmlFor={`product-${p.code}`} className="flex min-h-14 min-w-0 cursor-pointer items-center gap-3 p-3">
                    <RadioGroupItem id={`product-${p.code}`} value={p.code} className="shrink-0" />
                    <span className="min-w-0 flex-1 break-words font-medium">{p.name}</span>
                    <span className="font-bold tabular-nums">{formatCurrency(Number(p.price))}</span>
                  </label>
                </div>
              ))}
            </RadioGroup>
          </>
        )}

        {step === CONFIRM_STEP && product && (
          <dl className="space-y-3">
            <div><dt className="text-sm text-muted-foreground">Cliente</dt><dd className="break-words font-medium">{client.name}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Documento</dt><dd className="font-medium">{maskDocument(client.document)}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Produto</dt><dd className="font-medium">{product.name}</dd></div>
            <div>
              <dt className="text-sm text-muted-foreground">Valor</dt>
              <dd className="font-bold">{formatCurrency(Number(product.price))}</dd>
              {client.type === "PJ" && <dd className="text-base text-muted-foreground">{COMPANY_ONLY_NOTE}</dd>}
            </div>
          </dl>
        )}

        {created && orderId && product && (
          <div className="space-y-3">
            <p className="text-base text-muted-foreground">
              {client.name} · {product.name} · {formatCurrency(Number(product.price))}. Gere o link para o cliente pagar por Pix.
            </p>
            <GenerateLinkButton orderId={orderId} bureauName={bureauName} productName={product.name} />
            <Button type="button" variant="outline" onClick={restart}>Nova consulta</Button>
          </div>
        )}

        <div aria-live="polite">
          {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}
        </div>

        <p className="text-base text-muted-foreground">
          <span className="font-bold text-foreground">O que acontece depois: </span>
          {current.after}
        </p>

        {step < CONFIRM_STEP && (
          <Button type="button" className="w-full" onClick={(e) => { ignoreRepeatedClick(e); if (!e.defaultPrevented) next(); }}>
            Continuar
          </Button>
        )}
        {step === CONFIRM_STEP && (
          <Button type="button" className="w-full" onClick={(e) => { ignoreRepeatedClick(e); if (!e.defaultPrevented) open(); }} disabled={isPending || !confirmReady}>
            {isPending && <Loader2 aria-hidden className="animate-spin" />}
            {isPending ? "Abrindo..." : "Abrir consulta"}
          </Button>
        )}
      </section>

      <Dialog open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Sair sem concluir?" role="alertdialog">
        <p className="text-base">Os dados digitados serão perdidos.</p>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" variant="destructive" onClick={() => router.push(EXIT_HREF)}>Sair</Button>
          <Button type="button" variant="outline" onClick={() => setLeaveOpen(false)}>Continuar editando</Button>
        </div>
      </Dialog>
    </div>
  );
}
