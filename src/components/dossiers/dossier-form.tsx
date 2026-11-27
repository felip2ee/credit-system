"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type FieldErrors, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { openCounterOrderAction } from "@/actions/orders";
import type { Buyer } from "@/components/dossiers/buyer-picker";
import { isOwnResearch, missingThirdPartyEmail } from "@/components/dossiers/contact-rules";
import { DossierHolderStep, type CounterOrderFormValues } from "@/components/dossiers/dossier-holder-step";
import { useCnpjLookup } from "@/components/dossiers/use-cnpj-lookup";
import { DossierPartnersStep } from "@/components/dossiers/dossier-partners-step";
import { DossierProductStep, EMPRESARIAL_PRODUCT, type CatalogOption } from "@/components/dossiers/dossier-product-step";
import { DossierReviewStep } from "@/components/dossiers/dossier-review-step";
import {
	canLeaveStep,
	dossierSteps,
	hasTypedData,
	ownResearchContacts,
	stepForErrors,
	type DossierFormState,
	type DossierStepId,
} from "@/components/dossiers/dossier-wizard-steps";
import { countBillablePartners, orderTotalCents } from "@/components/orders/order-rules";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ScreenHeader } from "@/components/ui/screen-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { STEP_CLICK_GUARD_MS } from "@/lib/ui/step-guard";
import { formatCurrency } from "@/lib/utils";
import type { OrderProductCode } from "@/lib/orders/types";
import { counterOrderSchema } from "@/lib/validators/order";

export type { CatalogOption };

interface DossierFormProps {
	products: CatalogOption[];
}

const EXIT_HREF = "/dossiers";
const PF_PRODUCT = "dossie_pf";

// Duplo clique: só o primeiro clique age. Teclado (detail 0) e clique simples (detail 1) sempre passam.
const ignoreRepeatedClick = (event: React.MouseEvent<HTMLButtonElement>) => {
	if (event.detail > 1) event.preventDefault();
};

// Sangra até a borda do `main` do painel (p-4, md:p-6) para o cabeçalho fixo ocupar a largura toda.
const BLEED = "-mx-4 -mt-4 md:-mx-6 md:-mt-6";

// O cabeçalho fixo cobre o topo: o foco de um campo não fica embaixo dele (scroll-padding em globals.css).
const SECTION_CLASS = "space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200";

// Campos que cada etapa valida ao continuar.
function stepFields(step: DossierStepId, ownResearch: boolean): FieldPath<CounterOrderFormValues>[] {
	if (step === "holder") {
		return ownResearch ? ["subject.document", "subject.name"] : ["subject.document", "subject.name", "contactEmail", "contactPhone"];
	}
	if (step === "partners") return ["partners"];
	return [];
}

export function DossierForm({ products }: DossierFormProps) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [serverError, setServerError] = useState<string | null>(null);
	const [buyer, setBuyer] = useState<Buyer | null>(null);
	const [stepIndex, setStepIndex] = useState(0);
	const [leaveOpen, setLeaveOpen] = useState(false);
	// Produto sem sócios escolhido com sócios já digitados: espera a confirmação para removê-los.
	const [pendingProduct, setPendingProduct] = useState<string | null>(null);
	// Depois de um "Continuar" que falhou, os erros da etapa são revalidados a cada digitação.
	const [attempted, setAttempted] = useState(false);
	// O pedido só abre depois que a revisão foi mostrada (e passou o tempo de guarda).
	const [reviewReady, setReviewReady] = useState(false);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const shownStep = useRef(0);
	const submitting = useRef(false);
	// Depois de mandar o usuário a uma etapa com erro, o foco vai para o primeiro campo inválido dela.
	const [focusInvalid, setFocusInvalid] = useState(false);

	const form = useForm<CounterOrderFormValues>({
		resolver: zodResolver(counterOrderSchema),
		defaultValues: {
			productCode: (products[0]?.code ?? "") as CounterOrderFormValues["productCode"],
			buyerProfileId: null,
			subject: { name: "", document: "" },
			contactEmail: "",
			contactPhone: "",
			partners: [],
		},
	});
	const { handleSubmit, watch, setValue, getValues, setError, trigger, clearErrors, getFieldState } = form;

	const values = watch();
	const productCode = values.productCode;
	const ownResearch = isOwnResearch(values.subject.document ?? "", buyer?.document);
	const product = products.find((p) => p.code === productCode);
	const isEmpresarial = productCode === EMPRESARIAL_PRODUCT;
	const partnerCount = countBillablePartners(values.partners ?? [], values.subject.document);
	const total = product
		? orderTotalCents({ code: product.code as OrderProductCode, price: product.price, pricePerPartner: product.pricePerPartner }, partnerCount) / 100
		: 0;

	const steps = dossierSteps(productCode);
	const current = steps[Math.min(stepIndex, steps.length - 1)];
	const isLast = stepIndex >= steps.length - 1;
	const lookup = useCnpjLookup(form, current.id === "holder");

	const logicState = (): DossierFormState => {
		const v = getValues();
		return {
			productCode: v.productCode,
			ownResearch: isOwnResearch(v.subject.document ?? "", buyer?.document),
			hasBuyer: buyer !== null,
			subject: { name: v.subject.name ?? "", document: v.subject.document ?? "" },
			contactEmail: String(v.contactEmail ?? ""),
			contactPhone: String(v.contactPhone ?? ""),
			partners: (v.partners ?? []).map((p) => ({ name: p.name ?? "", document: p.document ?? "", email: p.email ?? "" })),
		};
	};

	// Ao trocar de etapa o foco vai para o título, para o leitor de tela anunciar onde está. Não na abertura
	// (o StrictMode roda o efeito duas vezes: comparar com a etapa já mostrada evita o foco falso).
	useEffect(() => {
		if (shownStep.current === stepIndex) return;
		shownStep.current = stepIndex;
		titleRef.current?.focus();
	}, [stepIndex]);

	const onReview = current.id === "review";
	useEffect(() => {
		if (!onReview) {
			setReviewReady(false);
			return;
		}
		const timer = setTimeout(() => setReviewReady(true), STEP_CLICK_GUARD_MS);
		return () => clearTimeout(timer);
	}, [onReview]);

	// Pesquisa própria: o contato vem da conta do cliente. Limpar o que foi digitado antes mantém o formulário igual ao payload.
	useEffect(() => {
		if (!ownResearch) return;
		setValue("contactEmail", "");
		setValue("contactPhone", "");
	}, [ownResearch, setValue]);

	// Valida os campos da etapa. O schema aceita e-mail vazio; para terceiro a etapa exige o e-mail.
	const validateStep = async (shouldFocus: boolean) => {
		await trigger(stepFields(current.id, ownResearch), { shouldFocus });
		const earlierInvalid = getFieldState("subject.document").invalid || getFieldState("subject.name").invalid;
		if (current.id === "holder" && !earlierInvalid && missingThirdPartyEmail(ownResearch, String(getValues("contactEmail") ?? ""))) {
			setError("contactEmail", { message: "Informe o e-mail do titular." }, { shouldFocus });
		}
	};

	const fieldsKey = JSON.stringify([values.subject, values.contactEmail, values.contactPhone, values.partners]);
	useEffect(() => {
		if (attempted) void validateStep(false);
		// Só a digitação dispara: fieldsKey resume os valores.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [attempted, fieldsKey]);

	useEffect(() => {
		if (!focusInvalid) return;
		setFocusInvalid(false);
		void validateStep(true);
		// Roda uma vez por envio recusado, já na etapa do erro.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focusInvalid]);

	// Nenhum envio falha em silêncio: volta à etapa do erro, revalida a cada digitação e foca o primeiro campo inválido.
	const sendToStep = (id: DossierStepId) => {
		const index = steps.findIndex((s) => s.id === id);
		if (index < 0) return false;
		setStepIndex(index);
		setAttempted(true);
		setFocusInvalid(true);
		return true;
	};

	const onInvalid = (errors: FieldErrors<CounterOrderFormValues>) => {
		const target = stepForErrors(errors);
		if (!target || !sendToStep(target)) setServerError("Revise os dados do pedido e tente novamente.");
	};

	const requestExit = () => {
		if (hasTypedData(logicState())) setLeaveOpen(true);
		else router.push(EXIT_HREF);
	};

	const goBack = () => {
		setAttempted(false);
		if (stepIndex === 0) requestExit();
		else setStepIndex(stepIndex - 1);
	};

	const goNext = async () => {
		if (lookup.pending) return;
		if (!canLeaveStep(current.id, logicState())) {
			setAttempted(true);
			await validateStep(true);
			return;
		}
		setAttempted(false);
		clearErrors(stepFields(current.id, ownResearch));
		setServerError(null);
		setStepIndex(stepIndex + 1);
	};

	const applyProduct = (code: string) => {
		setValue("productCode", code as CounterOrderFormValues["productCode"]);
		// Só o Dossiê Empresarial tem sócios.
		if (code !== EMPRESARIAL_PRODUCT) setValue("partners", []);
		setPendingProduct(null);
	};

	const requestProduct = (code: string) => {
		if (code === productCode) return;
		if (code !== EMPRESARIAL_PRODUCT && (getValues("partners") ?? []).length > 0) setPendingProduct(code);
		else applyProduct(code);
	};

	const onSubmit = () => {
		if (submitting.current) return;
		if (missingThirdPartyEmail(ownResearch, String(getValues("contactEmail") ?? ""))) {
			setError("contactEmail", { message: "Informe o e-mail do titular." });
			sendToStep("holder");
			return;
		}
		submitting.current = true;
		setServerError(null);
		startTransition(async () => {
			const raw = getValues();
			const payload = { ...raw, ...ownResearchContacts(ownResearch, { contactEmail: String(raw.contactEmail ?? ""), contactPhone: String(raw.contactPhone ?? "") }) };
			const res = await openCounterOrderAction({ ...payload, buyerProfileId: buyer?.profileId ?? null });
			if (res.error || !res.id) {
				submitting.current = false;
				setServerError(res.error ?? "Falha ao abrir o pedido.");
				return;
			}
			router.push(`/dossiers/${res.id}`);
			router.refresh();
		});
	};

	// Enter nas etapas antes da revisão avança; só a revisão abre o pedido.
	const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!isLast) return goNext();
		// Dinheiro: o botão só habilita depois do tempo de guarda; Enter antes disso não abre o pedido.
		if (!reviewReady) return;
		return handleSubmit(onSubmit, onInvalid)(event);
	};

	if (products.length === 0) {
		return (
			<StatusBanner
				tone="attention"
				title="Nenhum produto à venda no catálogo."
				description="Ative um produto em Configurações > Catálogo."
			/>
		);
	}

	return (
		<div className="space-y-6">
			<ScreenHeader
				className={BLEED}
				title="Pedido de balcão"
				onBack={goBack}
				onClose={requestExit}
				step={{ current: stepIndex + 1, total: steps.length, label: current.label }}
			/>
			<form onSubmit={onFormSubmit} noValidate className="mx-auto w-full max-w-2xl space-y-6">
				<section key={current.id} className={SECTION_CLASS}>
					<h2 ref={titleRef} tabIndex={-1} className="text-xl font-bold focus:outline-none">
						<span className="sr-only">
							Passo {stepIndex + 1} de {steps.length}:{" "}
						</span>
						{current.title}
					</h2>
					{current.id === "product" && (
						<DossierProductStep products={products} value={productCode} onChange={requestProduct} buyer={buyer} onBuyerChange={setBuyer} />
					)}
					{current.id === "holder" && <DossierHolderStep form={form} isPf={productCode === PF_PRODUCT} ownResearch={ownResearch} lookup={lookup} />}
					{current.id === "partners" && <DossierPartnersStep form={form} pricePerPartner={Number(product?.pricePerPartner ?? 0)} />}
					{current.id === "review" && (
						<DossierReviewStep
							productName={product?.name ?? ""}
							buyer={buyer}
							subjectName={values.subject.name ?? ""}
							subjectDocument={values.subject.document ?? ""}
							ownResearch={ownResearch}
							contactEmail={String(values.contactEmail ?? "")}
							contactPhone={String(values.contactPhone ?? "")}
							partnerCount={isEmpresarial ? partnerCount : 0}
							serverError={serverError}
						/>
					)}
					<p className="text-base text-muted-foreground">
						<span className="font-bold text-foreground">O que acontece depois: </span>
						{current.after}
					</p>
				</section>
				<p className="text-base" aria-live="polite">
					Total: <span className="font-bold">{formatCurrency(total)}</span>
				</p>
				{!isLast ? (
					<Button key="next" type="submit" className="w-full" onClick={ignoreRepeatedClick} disabled={lookup.pending}>
						Continuar
					</Button>
				) : (
					<Button key="open" type="submit" className="w-full" onClick={ignoreRepeatedClick} disabled={isPending || !reviewReady}>
						{isPending && <Loader2 aria-hidden className="animate-spin" />}
						{isPending ? "Abrindo pedido..." : "Abrir pedido"}
					</Button>
				)}
			</form>
			<Dialog open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Sair sem concluir?" role="alertdialog">
				<p className="text-base">Os dados digitados serão perdidos.</p>
				<div className="flex flex-col gap-2 sm:flex-row-reverse">
					<Button type="button" variant="destructive" onClick={() => router.push(EXIT_HREF)}>
						Sair
					</Button>
					<Button type="button" variant="outline" onClick={() => setLeaveOpen(false)}>
						Continuar editando
					</Button>
				</div>
			</Dialog>
			<Dialog open={pendingProduct !== null} onClose={() => setPendingProduct(null)} title="Remover os sócios?" role="alertdialog">
				<p className="text-base">
					Este produto não tem sócios. Os {(getValues("partners") ?? []).length} sócios informados serão removidos.
				</p>
				<div className="flex flex-col gap-2 sm:flex-row-reverse">
					<Button type="button" variant="destructive" onClick={() => pendingProduct && applyProduct(pendingProduct)}>
						Remover e trocar
					</Button>
					<Button type="button" variant="outline" onClick={() => setPendingProduct(null)}>
						Manter o produto
					</Button>
				</div>
			</Dialog>
		</div>
	);
}
