"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, TriangleAlert } from "lucide-react";

import { openClientOrderAction } from "@/actions/orders-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientOrderSchema } from "@/lib/validators/order";
import { formatCurrency } from "@/lib/utils";

export interface ClientOrderProduct {
	code: "consulta_pf" | "consulta_pj";
	name: string;
	price: string;
}

interface ClientOrderFormProps {
	products: ClientOrderProduct[];
	// Preço do parecer IA; nulo quando não está à venda.
	aiPrice: string | null;
	// Documento mascarado da própria conta; nulo quando a conta não tem titular próprio.
	selfDocumentMasked: string | null;
	available: string;
}

// Valores como o usuário digita: o schema transforma na saída, e a action valida de novo com a entrada crua.
interface FormValues {
	productCode: "consulta_pf" | "consulta_pj";
	withAi: boolean;
	self: boolean;
	subject: { name: string; document: string };
	contactEmail: string;
	contactPhone: string;
}

const toCents = (value: string): number => Math.round(Number(value) * 100);

export function ClientOrderForm({ products, aiPrice, selfDocumentMasked, available }: ClientOrderFormProps) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [serverError, setServerError] = useState<string | null>(null);

	const {
		register,
		handleSubmit,
		watch,
		setValue,
		getValues,
		formState: { errors },
	} = useForm<FormValues>({
		// O schema transforma a saída; a validação roda no valor cru e a action recebe a entrada crua.
		resolver: zodResolver(clientOrderSchema) as unknown as Resolver<FormValues>,
		defaultValues: {
			productCode: products[0]?.code ?? "consulta_pf",
			withAi: false,
			self: selfDocumentMasked !== null,
			subject: { name: "", document: "" },
			contactEmail: "",
			contactPhone: "",
		},
	});

	const productCode = watch("productCode");
	const withAi = watch("withAi");
	const isSelf = watch("self");
	const product = products.find((p) => p.code === productCode);
	const totalCents = toCents(product?.price ?? "0") + (withAi && aiPrice ? toCents(aiPrice) : 0);
	const insufficient = toCents(available) < totalCents;
	const documentLabel = productCode === "consulta_pf" ? "CPF" : "CNPJ";

	const onSubmit = () => {
		setServerError(null);
		startTransition(async () => {
			const result = await openClientOrderAction(getValues());
			if (result.error || !result.id) {
				setServerError(result.error ?? "Não foi possível abrir o pedido.");
				return;
			}
			router.push(`/portal/pesquisas/${result.id}`);
		});
	};

	return (
		<form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
			<Card>
				<CardHeader>
					<CardTitle className="text-lg">Produto</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<fieldset className="space-y-2">
						<legend className="sr-only">Produto</legend>
						{products.map((p) => (
							<label
								key={p.code}
								className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md border p-3 text-sm has-[:checked]:border-foreground"
							>
								<span className="flex items-center gap-2">
									<input type="radio" value={p.code} {...register("productCode")} />
									{p.name}
								</span>
								<span className="font-medium">{formatCurrency(Number(p.price))}</span>
							</label>
						))}
					</fieldset>
					{aiPrice !== null && (
						<label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
							<input type="checkbox" {...register("withAi")} />
							Incluir parecer IA (+ {formatCurrency(Number(aiPrice))})
						</label>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-lg">Para quem é a pesquisa?</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<fieldset className="space-y-2">
						<legend className="sr-only">Para quem é a pesquisa?</legend>
						{selfDocumentMasked !== null && (
							<label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
								<input type="radio" name="whom" checked={isSelf} onChange={() => setValue("self", true)} />
								Para mim ({selfDocumentMasked})
							</label>
						)}
						<label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
							<input type="radio" name="whom" checked={!isSelf} onChange={() => setValue("self", false)} />
							Para outra pessoa
						</label>
					</fieldset>

					{!isSelf && (
						<div className="space-y-4">
							<p className="text-sm text-muted-foreground">
								O titular recebe um pedido de autorização por e-mail e, se informado, por WhatsApp. A consulta só roda depois da
								autorização.
							</p>
							<div className="space-y-2">
								<Label htmlFor="subject-name">Nome do titular</Label>
								<Input
									id="subject-name"
									autoComplete="off"
									aria-invalid={Boolean(errors.subject?.name)}
									{...register("subject.name")}
								/>
								{errors.subject?.name && <p className="text-sm text-destructive">{errors.subject.name.message}</p>}
							</div>
							<div className="space-y-2">
								<Label htmlFor="subject-document">{documentLabel} do titular</Label>
								<Input
									id="subject-document"
									inputMode="numeric"
									autoComplete="off"
									aria-invalid={Boolean(errors.subject?.document)}
									{...register("subject.document")}
								/>
								{errors.subject?.document && <p className="text-sm text-destructive">{errors.subject.document.message}</p>}
							</div>
							<div className="space-y-2">
								<Label htmlFor="contact-email">E-mail do titular</Label>
								<Input
									id="contact-email"
									type="email"
									autoComplete="off"
									aria-invalid={Boolean(errors.contactEmail)}
									{...register("contactEmail")}
								/>
								{errors.contactEmail && <p className="text-sm text-destructive">{errors.contactEmail.message}</p>}
							</div>
							<div className="space-y-2">
								<Label htmlFor="contact-phone">Celular do titular (opcional)</Label>
								<Input
									id="contact-phone"
									type="tel"
									autoComplete="off"
									aria-invalid={Boolean(errors.contactPhone)}
									{...register("contactPhone")}
								/>
								{errors.contactPhone && <p className="text-sm text-destructive">{errors.contactPhone.message}</p>}
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardContent className="space-y-4 p-6">
					<dl className="grid grid-cols-2 gap-4 text-sm">
						<div>
							<dt className="text-muted-foreground">Total</dt>
							<dd className="text-2xl font-semibold">{formatCurrency(totalCents / 100)}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Saldo disponível</dt>
							<dd className="text-2xl font-semibold">{formatCurrency(Number(available))}</dd>
						</div>
					</dl>
					{insufficient ? (
						<div className="space-y-3">
							<p className="flex items-center gap-2 text-sm text-destructive" role="alert">
								<TriangleAlert className="h-4 w-4 shrink-0" />
								Saldo insuficiente para este pedido.
							</p>
							<Button asChild>
								<Link href="/portal/credits">Comprar créditos</Link>
							</Button>
						</div>
					) : (
						<Button type="submit" disabled={isPending}>
							{isPending && <Loader2 className="h-4 w-4 animate-spin" />}
							{isPending ? "Enviando..." : "Confirmar pedido"}
						</Button>
					)}
					<p aria-live="polite" className="text-sm text-destructive">
						{serverError}
					</p>
				</CardContent>
			</Card>
		</form>
	);
}
