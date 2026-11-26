"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { openClientOrderAction } from "@/actions/orders-client";
import {
	canConfirmOrder,
	isSelfOrder,
	orderHasMembers,
	orderPriceBreakdown,
	type HolderType,
	type ProductPrices,
} from "@/components/orders/order-rules";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import { CouponField, useCoupon } from "@/components/orders/coupon-field";
import { OrderPriceSummary } from "@/components/orders/order-price-summary";
import { ProductPicker } from "@/components/orders/product-picker";
import { ResearchIntro } from "@/components/orders/research-intro";
import { toCents } from "@/lib/catalog/money";
import type { OrderProductCode } from "@/lib/orders/types";
import { clientOrderSchema, MAX_PARTNERS } from "@/lib/validators/order";
import { failureMessage } from "@/lib/ui/failure-message";
import { formatCurrency } from "@/lib/utils";

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

// Valores como o usuário digita: o schema transforma na saída, e a action valida de novo com a entrada crua.
interface FormValues {
	productCode: OrderProductCode;
	self: boolean;
	subject: { name: string; document: string };
	contactEmail: string;
	contactPhone: string;
	partners: { name: string; document: string; email: string }[];
	declarationAccepted: boolean;
}

function FailureBanner({ what, next }: { what: string; next: string }) {
	const msg = failureMessage({ what, money: "not_charged", next });
	return (
		<StatusBanner
			tone="attention"
			title={msg.title}
			description={
				<>
					<p>{msg.money}</p>
					<p>{msg.next}</p>
				</>
			}
		/>
	);
}

export function ClientOrderForm({ products, holderType, selfDocumentMasked, available, declaration }: ClientOrderFormProps) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [serverError, setServerError] = useState<string | null>(null);
	const firstCode = products[0]?.code ?? "dossie_pf";

	const {
		register,
		handleSubmit,
		watch,
		setValue,
		getValues,
		control,
		reset,
		formState: { errors },
	} = useForm<FormValues>({
		// O schema transforma a saída; a validação roda no valor cru e a action recebe a entrada crua.
		resolver: zodResolver(clientOrderSchema) as unknown as Resolver<FormValues>,
		defaultValues: {
			productCode: firstCode,
			self: isSelfOrder(firstCode, holderType),
			subject: { name: "", document: "" },
			contactEmail: "",
			contactPhone: "",
			partners: [],
			declarationAccepted: false,
		},
	});
	const { fields, append, remove } = useFieldArray({ control, name: "partners" });

	const productCode = watch("productCode");
	const declarationAccepted = watch("declarationAccepted");
		const product = products.find((p) => p.code === productCode);
	const isSelf = isSelfOrder(productCode, holderType);
	const isEmpresarial = productCode === "dossie_empresarial";
	const hasMembers = orderHasMembers(productCode, holderType);
	const breakdown = product ? orderPriceBreakdown(product, watch("partners") ?? [], watch("subject.document")) : null;
	const listCents = breakdown?.totalCents ?? 0;
	const coupon = useCoupon({ productCode, partners: breakdown?.partnerCount ?? 0 }, listCents);
	const totalCents = coupon.totalCents;
	const insufficient = toCents(available) < totalCents;

	// Trocar de produto descarta o que não vale mais: dados de outra pessoa, sócios e a declaração.
	useEffect(() => {
		reset({
			productCode,
			self: isSelfOrder(productCode, holderType),
			subject: { name: "", document: "" },
			contactEmail: "",
			contactPhone: "",
			partners: [],
			declarationAccepted: false,
		});
		setServerError(null);
	}, [productCode, holderType, reset]);

	// Erro em campo que não está na tela nunca pode ser silencioso: o usuário vê o aviso na região aria-live.
	const onInvalid = () => setServerError("Revise os dados do pedido e tente novamente.");

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

	const documentLabel = isEmpresarial ? "CNPJ da empresa" : "CPF do responsável";
	const nameLabel = isEmpresarial ? "Razão social" : "Nome do responsável";

	return (
		<form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-6" noValidate>
			<ResearchIntro />
			<Card>
				<CardHeader>
					<CardTitle className="text-lg">Produto</CardTitle>
				</CardHeader>
				<CardContent>
						<ProductPicker
							products={products}
							value={productCode}
							onChange={(value) => setValue("productCode", value)}
							holderType={holderType}
						/>
				</CardContent>
			</Card>

			{isSelf ? (
				selfDocumentMasked !== null && (
					<p className="text-base text-muted-foreground">A pesquisa é sobre você ({selfDocumentMasked}). Você recebe um pedido de autorização por e-mail.</p>
				)
			) : (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">{isEmpresarial ? "Empresa" : "Responsável pela empresa"}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="text-base text-muted-foreground">
							Cada pessoa informada recebe um pedido de autorização por e-mail. A consulta só roda depois da autorização de todas.
						</p>
						<div className="space-y-2">
							<Label htmlFor="subject-document">{documentLabel}</Label>
							<Input
								id="subject-document"
								inputMode="numeric"
								autoComplete="off"
								aria-invalid={Boolean(errors.subject?.document)}
								{...register("subject.document")}
							/>
							{errors.subject?.document && <p className="text-base text-destructive">{errors.subject.document.message}</p>}
						</div>
						<div className="space-y-2">
							<Label htmlFor="subject-name">{nameLabel}</Label>
							<Input id="subject-name" autoComplete="off" aria-invalid={Boolean(errors.subject?.name)} {...register("subject.name")} />
							{errors.subject?.name && <p className="text-base text-destructive">{errors.subject.name.message}</p>}
						</div>
						<div className="space-y-2">
							<Label htmlFor="contact-email">E-mail do responsável</Label>
							<Input
								id="contact-email"
								type="email"
								autoComplete="off"
								aria-invalid={Boolean(errors.contactEmail)}
								{...register("contactEmail")}
							/>
							{errors.contactEmail && <p className="text-base text-destructive">{errors.contactEmail.message}</p>}
						</div>
					</CardContent>
				</Card>
			)}

			{isEmpresarial && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Sócios</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{fields.map((field, i) => (
							<div key={field.id} className="space-y-3 rounded-card border border-border bg-muted p-3">
								<div className="space-y-1">
									<Label htmlFor={`partner-name-${i}`}>Nome do sócio {i + 1}</Label>
									<Input
										id={`partner-name-${i}`}
										autoComplete="off"
										aria-invalid={Boolean(errors.partners?.[i]?.name)}
										{...register(`partners.${i}.name`)}
									/>
									{errors.partners?.[i]?.name && <p className="text-base text-destructive">{errors.partners[i]?.name?.message}</p>}
								</div>
								<div className="space-y-1">
									<Label htmlFor={`partner-doc-${i}`}>CPF do sócio {i + 1}</Label>
									<Input
										id={`partner-doc-${i}`}
										inputMode="numeric"
										autoComplete="off"
										aria-invalid={Boolean(errors.partners?.[i]?.document)}
										{...register(`partners.${i}.document`)}
									/>
									{errors.partners?.[i]?.document && (
										<p className="text-base text-destructive">{errors.partners[i]?.document?.message}</p>
									)}
								</div>
								<div className="space-y-1">
									<Label htmlFor={`partner-email-${i}`}>E-mail do sócio {i + 1}</Label>
									<Input
										id={`partner-email-${i}`}
										type="email"
										autoComplete="off"
										aria-invalid={Boolean(errors.partners?.[i]?.email)}
										{...register(`partners.${i}.email`)}
									/>
									{errors.partners?.[i]?.email && <p className="text-base text-destructive">{errors.partners[i]?.email?.message}</p>}
								</div>
								<Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => remove(i)} aria-label={`Remover sócio ${i + 1}`}>
									<Trash2 aria-hidden />
									Remover
								</Button>
							</div>
						))}
						{errors.partners?.message && <p className="text-base text-destructive">{errors.partners.message}</p>}
						<Button
							type="button"
							variant="outline"
							className="w-full sm:w-auto"
							disabled={fields.length >= MAX_PARTNERS}
							onClick={() => append({ name: "", document: "", email: "" })}
						>
							<Plus aria-hidden />
							Adicionar sócio
						</Button>
						<p className="text-base text-muted-foreground">Até {MAX_PARTNERS} sócios. Cada sócio autoriza a consulta pelo próprio e-mail.</p>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardContent className="space-y-4 p-6">
					{hasMembers && (
						<div className="space-y-2">
							<p className="whitespace-pre-line rounded-card border border-border bg-muted p-3 text-base" id="declaration-text">
								{declaration.bodyMd}
							</p>
							<div className="flex min-h-12 items-start gap-3">
								<Controller
									control={control}
									name="declarationAccepted"
									render={({ field }) => (
										<Checkbox
											id="declaration-accepted"
											className="mt-1"
											aria-describedby="declaration-text"
											checked={field.value}
											onCheckedChange={(checked) => field.onChange(checked === true)}
										/>
									)}
								/>
								<Label htmlFor="declaration-accepted" className="cursor-pointer text-base font-normal">
									Li e concordo com a declaração acima.
								</Label>
							</div>
						</div>
					)}
					{product?.code === "dossie_empresarial" && breakdown && (
						<OrderPriceSummary breakdown={breakdown} pricePerPartner={Number(product.pricePerPartner)} />
					)}
					<CouponField coupon={coupon} />
					<dl className="grid grid-cols-2 gap-4">
						<div>
							<dt className="text-muted-foreground">Total</dt>
							<dd className="text-2xl font-bold tabular-nums" aria-live="polite">
								{formatCurrency(totalCents / 100)}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Saldo disponível</dt>
							<dd className="text-2xl font-bold tabular-nums">{formatCurrency(Number(available))}</dd>
						</div>
					</dl>
					{insufficient && (
						<StatusBanner
							tone="attention"
							title="Saldo insuficiente para este pedido."
							description="Nada foi cobrado. Compre créditos e volte para confirmar."
						/>
					)}
					{serverError && <FailureBanner what={serverError} next="Revise os dados e tente de novo." />}
				</CardContent>
			</Card>
			<div className="sticky bottom-20 z-30 md:bottom-4">
				{insufficient ? (
					<Button asChild size="lg" glow className="w-full">
						<Link href="/portal/credits">Comprar créditos</Link>
					</Button>
				) : (
					<Button type="submit" size="lg" glow className="w-full" disabled={isPending || !canConfirmOrder({ hasMembers, declarationAccepted })}>
						{isPending && <Loader2 aria-hidden className="animate-spin" />}
						{isPending ? "Enviando..." : "Confirmar pedido"}
					</Button>
				)}
			</div>
		</form>
	);
}
