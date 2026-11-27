"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { createProduct, updateProduct } from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScreenHeader } from "@/components/ui/screen-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { normalizeMoney } from "@/lib/catalog/money-input";
import { STEP_CLICK_GUARD_MS } from "@/lib/ui/step-guard";
import { buildSalePrices } from "./price-input";
import {
  CODE_TAKEN_ERROR,
  hasTypedProductData,
  identityErrors,
  PARTNER_CODE,
  valuesErrors,
  type IdentityErrors,
  type ProductStepId,
  type ValuesErrors,
} from "./product-wizard-steps";

const EXIT_HREF = "/superadmin/products";

const STEPS: { id: ProductStepId; label: string; title: string; after: string }[] = [
  { id: "identity", label: "Identificação", title: "Identificação", after: "Você informa o custo e o preço de venda." },
  {
    id: "values",
    label: "Valores",
    title: "Valores",
    after:
      "O produto e a primeira versão são criados e você vai para a página do produto. Sem preço de venda, nenhum Bureau vende o produto.",
  },
];

// Duplo clique: só o primeiro clique age. Teclado (detail 0) e clique simples (detail 1) sempre passam.
const ignoreRepeatedClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  if (event.detail > 1) event.preventDefault();
};

// Sangra até a borda do `main` do painel (p-4, md:p-6) para o cabeçalho fixo ocupar a largura toda.
const BLEED = "-mx-4 -mt-4 md:-mx-6 md:-mt-6";

// Ordem dos campos na tela, para focar o primeiro inválido.
const IDENTITY_IDS = { code: "product-code", name: "product-name", depsProduct: "product-deps" } as const;
const VALUES_IDS = {
  baseCost: "product-cost",
  baseCostPerPartner: "product-cost-partner",
  salePrice: "product-price",
  salePricePerPartner: "product-price-partner",
} as const;

function focusFirst<K extends string>(ids: Record<K, string>, errors: Partial<Record<K, string>>) {
  const first = (Object.keys(ids) as K[]).find((key) => errors[key]);
  if (first) document.getElementById(ids[first])?.focus();
}

export function ProductForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [reviewReady, setReviewReady] = useState(false);
  const [focusCode, setFocusCode] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [depsProduct, setDepsProduct] = useState("");
  const [baseCost, setBaseCost] = useState("");
  const [baseCostPerPartner, setBaseCostPerPartner] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [salePricePerPartner, setSalePricePerPartner] = useState("");
  const [idErrors, setIdErrors] = useState<IdentityErrors>({});
  const [valErrors, setValErrors] = useState<ValuesErrors>({});
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(0);
  const hasPartner = code === PARTNER_CODE;
  const current = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  // Ao trocar de etapa o foco vai para o título (não na abertura: o StrictMode roda o efeito duas vezes).
  useEffect(() => {
    if (shownStep.current === stepIndex) return;
    shownStep.current = stepIndex;
    titleRef.current?.focus();
  }, [stepIndex]);

  // Código já em uso volta à etapa 1: o foco vai ao campo, depois do foco no título.
  useEffect(() => {
    if (!focusCode || stepIndex !== 0) return;
    setFocusCode(false);
    document.getElementById(IDENTITY_IDS.code)?.focus();
  }, [focusCode, stepIndex]);

  // O botão final só habilita depois do tempo de guarda: um duplo clique em "Continuar" não cria o produto.
  useEffect(() => {
    if (!isLast) {
      setReviewReady(false);
      return;
    }
    const timer = setTimeout(() => setReviewReady(true), STEP_CLICK_GUARD_MS);
    return () => clearTimeout(timer);
  }, [isLast]);

  const typed = { code, name, depsProduct, baseCost, baseCostPerPartner, salePrice, salePricePerPartner };

  const requestExit = () => {
    if (hasTypedProductData(typed)) setLeaveOpen(true);
    else router.push(EXIT_HREF);
  };

  const goBack = () => {
    if (stepIndex === 0) requestExit();
    else setStepIndex(stepIndex - 1);
  };

  const goNext = () => {
    const errors = identityErrors({ code, name, depsProduct });
    setIdErrors(errors);
    if (Object.keys(errors).length > 0) return focusFirst(IDENTITY_IDS, errors);
    setStepIndex(1);
  };

  const submit = () => {
    const errors = valuesErrors({ baseCost, baseCostPerPartner, salePrice, salePricePerPartner, hasPartner });
    setValErrors(errors);
    if (Object.keys(errors).length > 0) return focusFirst(VALUES_IDS, errors);
    setError(null);
    startTransition(async () => {
      const result = await createProduct({
        ...buildSalePrices(salePrice, salePricePerPartner, hasPartner),
        code,
        name,
        depsProduct,
        baseCost: normalizeMoney(baseCost),
        baseCostPerPartner: hasPartner ? normalizeMoney(baseCostPerPartner) : "0.00",
      });
      if (result.error === CODE_TAKEN_ERROR) {
        setIdErrors({ code: result.error });
        setStepIndex(0);
        setFocusCode(true);
        return;
      }
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push(`/superadmin/products/${result.id}`);
    });
  };

  // Enter na primeira etapa avança; só a segunda cria o produto, e só depois do tempo de guarda.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLast) return goNext();
    if (!reviewReady || isPending) return;
    submit();
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        className={BLEED}
        title="Novo produto"
        onBack={goBack}
        onClose={requestExit}
        step={{ current: stepIndex + 1, total: STEPS.length, label: current.label }}
      />
      <form onSubmit={onSubmit} noValidate className="mx-auto w-full max-w-xl space-y-6">
        <section key={current.id} className="space-y-4 motion-safe:animate-fade-in [&_input]:scroll-mt-20">
          <h2 ref={titleRef} tabIndex={-1} className="text-xl font-bold focus:outline-none">
            <span className="sr-only">
              Passo {stepIndex + 1} de {STEPS.length}:{" "}
            </span>
            {current.title}
          </h2>
          {current.id === "identity" && (
            <>
              <Field
                id={IDENTITY_IDS.code}
                label="Código"
                helper="Letras minúsculas, números e _. Não muda depois de criado."
                error={idErrors.code}
              >
                {(a11y) => <Input {...a11y} value={code} onChange={(e) => setCode(e.target.value)} />}
              </Field>
              <Field id={IDENTITY_IDS.name} label="Nome" error={idErrors.name}>
                {(a11y) => <Input {...a11y} value={name} onChange={(e) => setName(e.target.value)} />}
              </Field>
              <Field
                id={IDENTITY_IDS.depsProduct}
                label="Nome DEPS"
                helper="Deixe em branco se o produto não consulta o DEPS."
                error={idErrors.depsProduct}
              >
                {(a11y) => <Input {...a11y} value={depsProduct} onChange={(e) => setDepsProduct(e.target.value)} />}
              </Field>
            </>
          )}
          {current.id === "values" && (
            <>
              <Field
                id={VALUES_IDS.baseCost}
                label={hasPartner ? "Custo interno da empresa (R$)" : "Custo interno (R$)"}
                error={valErrors.baseCost}
              >
                {(a11y) => (
                  <Input {...a11y} inputMode="decimal" placeholder="0,00" value={baseCost} onChange={(e) => setBaseCost(e.target.value)} />
                )}
              </Field>
              {hasPartner && (
                <Field id={VALUES_IDS.baseCostPerPartner} label="Custo interno por sócio (R$)" error={valErrors.baseCostPerPartner}>
                  {(a11y) => (
                    <Input
                      {...a11y}
                      inputMode="decimal"
                      placeholder="0,00"
                      value={baseCostPerPartner}
                      onChange={(e) => setBaseCostPerPartner(e.target.value)}
                    />
                  )}
                </Field>
              )}
              <Field
                id={VALUES_IDS.salePrice}
                label={hasPartner ? "Preço de venda da empresa (R$)" : "Preço de venda (R$)"}
                helper={salePrice.trim() === "" ? "Sem preço = não está à venda. Nenhum Bureau vende o produto." : undefined}
                error={valErrors.salePrice}
              >
                {(a11y) => (
                  <Input {...a11y} inputMode="decimal" placeholder="0,00" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
                )}
              </Field>
              {hasPartner && (
                <Field id={VALUES_IDS.salePricePerPartner} label="Preço de venda por sócio (R$)" error={valErrors.salePricePerPartner}>
                  {(a11y) => (
                    <Input
                      {...a11y}
                      inputMode="decimal"
                      placeholder="0,00"
                      value={salePricePerPartner}
                      onChange={(e) => setSalePricePerPartner(e.target.value)}
                    />
                  )}
                </Field>
              )}
              {error && <StatusBanner tone="danger" title={error} />}
            </>
          )}
          <p className="text-base text-muted-foreground">
            <span className="font-bold text-foreground">O que acontece depois: </span>
            {current.after}
          </p>
        </section>
        {!isLast ? (
          <Button key="next" type="submit" className="w-full" onClick={ignoreRepeatedClick}>
            Continuar
          </Button>
        ) : (
          <Button key="create" type="submit" className="w-full" onClick={ignoreRepeatedClick} disabled={isPending || !reviewReady}>
            {isPending && <Loader2 aria-hidden className="animate-spin" />}
            {isPending ? "Criando..." : "Criar produto"}
          </Button>
        )}
      </form>
      <Dialog open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Sair sem concluir?" role="alertdialog">
        <p className="text-base">Os dados digitados serão perdidos.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => setLeaveOpen(false)}>
            Continuar editando
          </Button>
          <Button type="button" variant="destructive" onClick={() => router.push(EXIT_HREF)}>
            Sair
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function ProductEditForm({
  product,
}: {
  product: { id: string; name: string; active: boolean };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(product.name);
  const [active, setActive] = useState(product.active);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateProduct({ id: product.id, name, active });
      setConfirmOpen(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  // Desativar para a venda na hora: pede confirmação. Ativar ou só renomear salva direto.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (product.active && !active) setConfirmOpen(true);
    else save();
  };

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4">
      <Field id="edit-name" label="Nome">
        {(a11y) => <Input {...a11y} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <div className="space-y-1.5">
        <label className="flex min-h-11 items-center gap-3 text-base">
          <Checkbox
            checked={active}
            onCheckedChange={(checked) => setActive(checked === true)}
            aria-describedby="edit-active-help"
          />
          Produto ativo
        </label>
        <p id="edit-active-help" className="text-sm text-muted-foreground">
          Produto inativo sai do catálogo dos Bureaus e não pode ser vendido. As versões e o histórico ficam guardados.
        </p>
      </div>
      {error && <StatusBanner tone="danger" title={error} />}
      {saved && <StatusBanner tone="success" title="Salvo." />}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando..." : "Salvar"}
      </Button>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Desativar produto?" role="alertdialog" dismissible={!isPending} className="max-h-[92vh] overflow-y-auto">
        <p className="text-base">
          {product.name} sai do catálogo dos Bureaus e não pode mais ser vendido. Pedidos já reservados continuam. As versões e o histórico ficam guardados.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button type="button" variant="destructive" onClick={save} disabled={isPending}>
            {isPending ? "Desativando..." : "Desativar"}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
