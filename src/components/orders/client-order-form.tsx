"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type FieldErrors, type FieldPath, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { openClientOrderAction } from "@/actions/orders-client";
import {
	canConfirmOrder,
	isSelfOrder,
	orderHasMembers,
	orderPriceBreakdown,
	type HolderType,
	type ProductPrices,
} from "@/components/orders/order-rules";
import { canLeaveStep, hasTypedData, wizardSteps, type OrderFormValues, type WizardStepId } from "@/components/orders/order-wizard-steps";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ScreenHeader } from "@/components/ui/screen-header";
import { useCoupon } from "@/components/orders/coupon-field";
import { PartnersStep } from "@/components/orders/partners-step";
import { ProductPicker } from "@/components/orders/product-picker";
import { ResearchIntro } from "@/components/orders/research-intro";
import { ReviewStep } from "@/components/orders/review-step";
import { SubjectStep } from "@/components/orders/subject-step";
import { toCents } from "@/lib/catalog/money";
import { clientOrderSchema } from "@/lib/validators/order";

export interface ClientOrderProduct extends ProductPrices {
	name: string;
}

interface ClientOrderFormProps {
	products: ClientOrderProduct[];
	holderType: HolderType;
	// Documento mascarado da própria conta; nulo quando a conta não tem titular próprio.
	selfDocumentMasked: string | null;
	available: string;
	declaration: { version: number; title: string; bodyMd: string };
}

const EXIT_HREF = "/portal/pesquisas";

// Campos que cada etapa valida ao continuar. A escolha de produto e a revisão não têm campo de texto.
const STEP_FIELDS: Record<WizardStepId, (isSelf: boolean) => FieldPath<OrderFormValues>[]> = {
	product: () => [],
	data: (isSelf) => (isSelf ? [] : ["subject.document", "subject.name", "contactEmail"]),
	partners: () => ["partners"],
	review: () => [],
};

const emptyValues = (productCode: OrderFormValues["productCode"], holderType: HolderType): OrderFormValues => ({
	productCode,
	self: isSelfOrder(productCode, holderType),
	subject: { name: "", document: "" },
	contactEmail: "",
	contactPhone: "",
	partners: [],
	declarationAccepted: false,
});

// Primeira etapa que tem erro, para devolver o usuário a ela se a confirmação final falhar.
function stepWithError(errors: FieldErrors<OrderFormValues>): WizardStepId | null {
	if (errors.subject || errors.contactEmail) return "data";
	if (errors.partners) return "partners";
	return null;
}

export function ClientOrderForm({ products, holderType, selfDocumentMasked, available, declaration }: ClientOrderFormProps) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [serverError, setServerError] = useState<string | null>(null);
	const [stepIndex, setStepIndex] = useState(0);
	const [leaveOpen, setLeaveOpen] = useState(false);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const firstRender = useRef(true);
	const firstCode = products[0]?.code ?? "dossie_pf";

	const form = useForm<OrderFormValues>({
		// O schema transforma a saída; a validação roda no valor cru e a action recebe a entrada crua.
		resolver: zodResolver(clientOrderSchema) as unknown as Resolver<OrderFormValues>,
		defaultValues: emptyValues(firstCode, holderType),
	});
	const { handleSubmit, watch, setValue, getValues, reset, trigger } = form;

	const values = watch();
	const { productCode, declarationAccepted } = values;
	const product = products.find((p) => p.code === productCode);
	const isSelf = isSelfOrder(productCode, holderType);
	const hasMembers = orderHasMembers(productCode, holderType);
	const breakdown = product ? orderPriceBreakdown(product, values.partners, values.subject.document) : null;
	const coupon = useCoupon({ productCode, partners: breakdown?.partnerCount ?? 0 }, breakdown?.totalCents ?? 0);
	const insufficient = toCents(available) < coupon.totalCents;

	const steps = wizardSteps(productCode, holderType);
	const current = steps[Math.min(stepIndex, steps.length - 1)];
	const isLast = stepIndex >= steps.length - 1;

	// Trocar de produto descarta o que não vale mais: dados de outra pessoa, sócios e a declaração.
	useEffect(() => {
		reset(emptyValues(productCode, holderType));
		setServerError(null);
	}, [productCode, holderType, reset]);

	// Ao trocar de etapa o foco vai para o título, para o leitor de tela anunciar onde está. Não na abertura.
	useEffect(() => {
		if (firstRender.current) {
			firstRender.current = false;
			return;
		}
		titleRef.current?.focus();
	}, [stepIndex]);

	const requestExit = () => {
		if (hasTypedData(getValues())) setLeaveOpen(true);
		else router.push(EXIT_HREF);
	};

	const goBack = () => {
		if (stepIndex === 0) requestExit();
		else setStepIndex(stepIndex - 1);
	};

	const goNext = async () => {
		if (!canLeaveStep(current.id, getValues())) {
			await trigger(STEP_FIELDS[current.id](isSelf), { shouldFocus: true });
			return;
		}
		setServerError(null);
		setStepIndex(stepIndex + 1);
	};

	// Erro em campo de outra etapa nunca pode ser silencioso: volta para a etapa do erro ou avisa na região aria-live.
	const onInvalid = (errors: FieldErrors<OrderFormValues>) => {
		const target = stepWithError(errors);
		const index = steps.findIndex((s) => s.id === target);
		if (index >= 0) setStepIndex(index);
		else setServerError("Revise os dados do pedido e tente novamente.");
	};

	const onSubmit = () => {
		setServerError(null);
		startTransition(async () => {
			const result = await openClientOrderAction({
				...getValues(),
				declarationVersion: declaration.version,
				...(coupon.couponCode ? { couponCode: coupon.couponCode } : {}),
			});
			if (!result || result.error || !result.id) {
				setServerError(result?.error ?? "Não foi possível abrir o pedido.");
				return;
			}
			router.push(`/portal/pesquisas/${result.id}`);
		});
	};

	// Enter nas etapas 1 a 3 avança; só a última etapa confirma o pedido.
	const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		if (isLast) return handleSubmit(onSubmit, onInvalid)(event);
		event.preventDefault();
		return goNext();
	};

	return (
		<div className="space-y-6">
			<ScreenHeader
				title="Nova pesquisa"
				onBack={goBack}
				onClose={requestExit}
				step={{ current: stepIndex + 1, total: steps.length, label: current.label }}
			/>
			<form onSubmit={onFormSubmit} className="space-y-6" noValidate>
				<section key={current.id} className="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
					<h2 ref={titleRef} tabIndex={-1} className="text-xl font-bold focus:outline-none">
						{current.title}
					</h2>
					{current.id === "product" && (
						<>
							<ResearchIntro />
							<ProductPicker
								products={products}
								value={productCode}
								onChange={(value) => setValue("productCode", value)}
								holderType={holderType}
							/>
						</>
					)}
					{current.id === "data" && (
						<SubjectStep form={form} isSelf={isSelf} isEmpresarial={productCode === "dossie_empresarial"} selfDocumentMasked={selfDocumentMasked} />
					)}
					{current.id === "partners" && <PartnersStep form={form} pricePerPartner={Number(product?.pricePerPartner ?? 0)} />}
					{current.id === "review" && (
						<ReviewStep
							form={form}
							values={values}
							productName={product?.name ?? ""}
							holderType={holderType}
							isSelf={isSelf}
							hasMembers={hasMembers}
							selfDocumentMasked={selfDocumentMasked}
							declarationBody={declaration.bodyMd}
							breakdown={breakdown}
							pricePerPartner={product ? Number(product.pricePerPartner) : null}
							coupon={coupon}
							available={available}
							insufficient={insufficient}
							serverError={serverError}
						/>
					)}
					<p className="text-base text-muted-foreground">
						<span className="font-bold text-foreground">O que acontece depois: </span>
						{current.after}
					</p>
				</section>
				<div className="sticky bottom-20 z-30 -mx-screen border-t border-border bg-background px-screen py-3 md:bottom-0">
					{!isLast ? (
						<Button key="next" type="submit" size="lg" glow className="w-full">
							Continuar
						</Button>
					) : insufficient ? (
						<Button asChild size="lg" glow className="w-full">
							<Link href="/portal/credits">Comprar créditos</Link>
						</Button>
					) : (
						<Button key="confirm" type="submit" size="lg" glow className="w-full" disabled={isPending || !canConfirmOrder({ hasMembers, declarationAccepted })}>
							{isPending && <Loader2 aria-hidden className="animate-spin" />}
							{isPending ? "Enviando..." : "Confirmar pedido"}
						</Button>
					)}
				</div>
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
		</div>
	);
}
