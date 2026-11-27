"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Landmark, QrCode } from "lucide-react";

import { setPayoutMethodAction } from "@/actions/affiliate-payout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { StatusBanner } from "@/components/ui/status-banner";
import type { PayoutSettings } from "@/lib/affiliates/payout-settings";
import { ASAAS_APP_STORE_LINKS } from "@/lib/affiliates/store-links";
import type { PayoutMethod } from "@/lib/affiliates/types";
import { cn } from "@/lib/utils";

interface PayoutMethodCardsProps {
	current: PayoutSettings;
	// Só quando o dono do bureau ou o superadmin cadastra em nome do afiliado.
	profileId?: string;
	// Nome do afiliado, quando outra pessoa cadastra; sem ele, o texto fala "em seu nome".
	subject?: string;
}

export function PayoutMethodCards({ current, profileId, subject }: PayoutMethodCardsProps) {
	const router = useRouter();
	const uid = useId();
	const [method, setMethod] = useState<PayoutMethod>(current.method);
	const [walletId, setWalletId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [isPending, startTransition] = useTransition();

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setSaved(false);
		startTransition(async () => {
			const res = await setPayoutMethodAction({ profileId, method, asaasWalletId: walletId });
			if (res.error) return setError(res.error);
			setSaved(true);
			setWalletId("");
			router.refresh();
		});
	};

	const asaasId = `${uid}-asaas`;
	const pixId = `${uid}-pix`;
	const cardClass = (active: boolean) => cn("transition-colors", active && "border-primary ring-2 ring-primary/30");

	return (
		<form onSubmit={submit} className="space-y-6" noValidate>
			<p id={`${uid}-group`} className="text-base font-bold">
				Como receber a comissão
			</p>
			<RadioGroup
				value={method}
				onValueChange={(v) => setMethod(v as PayoutMethod)}
				aria-labelledby={`${uid}-group`}
				className="grid gap-4 md:grid-cols-2"
				disabled={isPending}
			>
				<Card className={cardClass(method === "asaas")}>
					<CardHeader className="flex-row items-start gap-3 space-y-0">
						<RadioGroupItem value="asaas" id={asaasId} className="mt-1" />
						<Label htmlFor={asaasId} className="flex-1 cursor-pointer space-y-1">
							<span className="flex items-center gap-2 text-lg font-bold">
								<Landmark aria-hidden className="size-5" /> Conta Asaas
							</span>
							<span className="block text-base font-normal text-muted-foreground">
								Recebe na hora, a cada pagamento do cliente.
							</span>
						</Label>
					</CardHeader>
					<CardContent className="space-y-4">
						<ul className="list-disc space-y-1 pl-5 text-base">
							<li>A taxa do Asaas já vem descontada.</li>
							<li>Sem carência e sem pedido de saque.</li>
							<li>Precisa de uma conta Asaas aberta {subject ? `em nome de ${subject}` : "em seu nome"}.</li>
						</ul>
						<div className="flex flex-wrap gap-2">
							<Button asChild variant="outline" size="sm">
								<a href={ASAAS_APP_STORE_LINKS.android} target="_blank" rel="noopener noreferrer">
									Baixar na Play Store<span className="sr-only"> (abre em nova aba)</span>
								</a>
							</Button>
							<Button asChild variant="outline" size="sm">
								<a href={ASAAS_APP_STORE_LINKS.ios} target="_blank" rel="noopener noreferrer">
									Baixar na App Store<span className="sr-only"> (abre em nova aba)</span>
								</a>
							</Button>
						</div>
						{method === "asaas" && (
							<Field
								id={`${uid}-wallet`}
								label="walletId da conta Asaas"
								helper={
									current.walletIdMasked
										? `ID salvo: ${current.walletIdMasked}. Confira se é o seu. Deixe em branco para manter.`
										: "No app Asaas, abra os dados da conta e copie o walletId. Confira o ID antes de salvar."
								}
							>
								{(a11y) => (
									<Input
										{...a11y}
										value={walletId}
										onChange={(e) => setWalletId(e.target.value)}
										placeholder="00000000-0000-0000-0000-000000000000"
										autoComplete="off"
										spellCheck={false}
										disabled={isPending}
									/>
								)}
							</Field>
						)}
					</CardContent>
				</Card>

				<Card className={cardClass(method === "pix")}>
					<CardHeader className="flex-row items-start gap-3 space-y-0">
						<RadioGroupItem value="pix" id={pixId} className="mt-1" />
						<Label htmlFor={pixId} className="flex-1 cursor-pointer space-y-1">
							<span className="flex items-center gap-2 text-lg font-bold">
								<QrCode aria-hidden className="size-5" /> Chave Pix
							</span>
							<span className="block text-base font-normal text-muted-foreground">
								Sem conta Asaas. A comissão vira saldo no portal.
							</span>
						</Label>
					</CardHeader>
					<CardContent>
						<ul className="list-disc space-y-1 pl-5 text-base">
							<li>O valor entra no saldo quando o pagamento do cliente é confirmado.</li>
							<li>Ele fica liberado depois da carência configurada (padrão: 0 dia).</li>
							<li>Você saca por Pix, com a taxa de saque do programa.</li>
						</ul>
					</CardContent>
				</Card>
			</RadioGroup>

			<CardDescription>A mudança vale só para cobranças criadas depois de salvar.</CardDescription>
			{error && <StatusBanner tone="danger" title={error} />}
			{saved && !error && <StatusBanner tone="success" title="Forma de recebimento salva." />}
			<Button type="submit" size="lg" disabled={isPending}>
				{isPending ? "Salvando..." : "Salvar"}
			</Button>
		</form>
	);
}
