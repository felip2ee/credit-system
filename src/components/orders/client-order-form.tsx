"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormProvider, useFieldArray, useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { openClientOrderAction } from "@/actions/orders-client";
import { useCoupon } from "@/components/orders/coupon-field";
import { PeopleStep } from "@/components/orders/order-step-people";
import { ReviewStep } from "@/components/orders/order-step-review";
import { SubjectStep } from "@/components/orders/order-step-subject";
import {
	billablePartners,
	canAddSelf,
	canConfirmOrder,
	hasBuyerRow,
	isSelfOrder,
	orderHasMembers,
	orderPriceBreakdown,
	reviewActionLabel,
	type HolderType,
	type ProductPrices,
} from "@/components/orders/order-rules";
import {
	ORDER_STEP_FIELDS,
	orderStepsFor,
	orderStepTitle,
	stepWithErrors,
	type OrderFormValues,
	type OrderStep,
} from "@/components/orders/order-wizard-steps";
import { ProductPicker } from "@/components/orders/product-picker";
import { ResearchIntro } from "@/components/orders/research-intro";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clientOrderSchema } from "@/lib/validators/order";

export interface ClientOrderProduct extends ProductPrices {
	name: string;
}

interface ClientOrderFormProps {
	products: ClientOrderProduct[];
	holderType: HolderType;
	// Documento mascarado da própria conta; nulo quando a conta não tem titular próprio.
	selfDocumentMasked: string | null;
	// Quem compra: "Adicionar eu" usa nome e e-mail da conta.
	buyer: { name: string; email: string };
	declaration: { version: number; title: string; bodyMd: string };
}

const emptyValues = (productCode: OrderFormValues["productCode"], holderType: HolderType): OrderFormValues => ({
	productCode,
	self: isSelfOrder(productCode, holderType),
	subject: { name: "", document: "" },
	contactEmail: "",
	contactPhone: "",
	partners: [],
	declarationAccepted: false,
});

export function ClientOrderForm({ products, holderType, selfDocumentMasked, buyer, declaration }: ClientOrderFormProps) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [serverError, setServerError] = useState<string | null>(null);
	const [step, setStep] = useState<OrderStep>("choice");
	const headingRef = useRef<HTMLHeadingElement>(null);
	const prevStep = useRef<OrderStep>("choice");
	const firstCode = products[0]?.code ?? "dossie_pf";

	const methods = useForm<OrderFormValues>({
		// O schema transforma a saída; a validação roda no valor cru e a action recebe a entrada crua.
		resolver: zodResolver(clientOrderSchema) as unknown as Resolver<OrderFormValues>,
		defaultValues: emptyValues(firstCode, holderType),
	});
	const { handleSubmit, watch, setValue, getValues, control, reset, trigger } = methods;
	const { fields, append, remove } = useFieldArray({ control, name: "partners" });

	const productCode = watch("productCode");
	const partners = watch("partners") ?? [];
	const subject = watch("subject");
	const declarationAccepted = watch("declarationAccepted");
	const product = products.find((p) => p.code === productCode);
	const steps = orderStepsFor(productCode, holderType);
	const stepIndex = Math.max(0, steps.indexOf(step));
	const isLast = stepIndex === steps.length - 1;
	const hasMembers = orderHasMembers(productCode, holderType);
	const breakdown = product ? orderPriceBreakdown(product, partners, subject.document) : null;
	const coupon = useCoupon({ productCode, partners: breakdown?.partnerCount ?? 0 }, breakdown?.totalCents ?? 0);
	const totalCents = coupon.totalCents;

	// Trocar a escolha descarta o que não vale mais: dados de outra pessoa, lista e declaração. "Voltar" nunca reseta.
	useEffect(() => {
		reset(emptyValues(productCode, holderType));
		setServerError(null);
	}, [productCode, holderType, reset]);

	// A cada troca de etapa o foco vai ao título (não na abertura).
	useEffect(() => {
		if (prevStep.current !== step) headingRef.current?.focus();
		prevStep.current = step;
	}, [step]);

	const goBack = () => {
		setServerError(null);
		setStep(steps[Math.max(0, stepIndex - 1)] ?? "choice");
	};

	const goNext = async () => {
		const fieldsToCheck = ORDER_STEP_FIELDS[step];
		const ok = fieldsToCheck.length === 0 || (await trigger([...fieldsToCheck], { shouldFocus: true }));
		if (ok) setStep(steps[stepIndex + 1] ?? step);
	};

	// Erro de etapa anterior leva o usuário até ela; sem etapa com erro, o aviso fica na região aria-live.
	const onInvalid = (errors: FieldErrors<OrderFormValues>) => {
		const back = stepWithErrors(steps, Object.keys(errors));
		if (back && back !== step) setStep(back);
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
			router.push(`/portal/pesquisas/${result.id}${result.paymentRequired ? "/pagar" : ""}`);
		});
	};

	// Fora da última etapa o Enter avança; nunca envia o pedido sem passar pela revisão.
	const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		if (isLast) return handleSubmit(onSubmit, onInvalid)(event);
		event.preventDefault();
		return goNext();
	};

	return (
		<FormProvider {...methods}>
			<form onSubmit={onFormSubmit} className="space-y-4" noValidate>
				{step === "choice" && <ResearchIntro />}
				<Card>
					<CardHeader>
						<p className="text-sm text-muted-foreground">
							Etapa {stepIndex + 1} de {steps.length}
						</p>
						<CardTitle>
							<h2 ref={headingRef} tabIndex={-1} className="outline-none">
								{orderStepTitle(step, productCode)}
							</h2>
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{step === "choice" && (
							<ProductPicker products={products} value={productCode} onChange={(value) => setValue("productCode", value)} holderType={holderType} />
						)}
						{step === "subject" && <SubjectStep productCode={productCode} />}
						{step === "people" && (
							<PeopleStep
								fields={fields}
								onAdd={(row) => append({ name: "", document: "", email: "", ...row })}
								onRemove={remove}
								canAddSelf={canAddSelf(holderType) && !hasBuyerRow(partners, buyer.email)}
								buyer={buyer}
								selfDocumentMasked={selfDocumentMasked}
							/>
						)}
						{step === "review" && product && (
							<ReviewStep
								product={product}
								productCode={productCode}
								subject={isSelfOrder(productCode, holderType) ? null : subject}
								people={billablePartners(partners, subject.document)}
								breakdown={breakdown}
								coupon={coupon}
								totalCents={totalCents}
								hasMembers={hasMembers}
								declaration={declaration}
								selfDocumentMasked={selfDocumentMasked}
								serverError={serverError}
							/>
						)}
					</CardContent>
				</Card>
				<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					{stepIndex > 0 && (
						<Button type="button" variant="outline" onClick={goBack} disabled={isPending}>
							Voltar
						</Button>
					)}
					{isLast ? (
						<Button key="submit" type="submit" size="lg" glow disabled={isPending || !canConfirmOrder({ hasMembers, declarationAccepted })}>
							{isPending && <Loader2 aria-hidden className="animate-spin" />}
							{isPending ? "Enviando..." : reviewActionLabel(totalCents)}
						</Button>
					) : (
						<Button key="next" type="submit" glow>
							Continuar
						</Button>
					)}
				</div>
			</form>
		</FormProvider>
	);
}
