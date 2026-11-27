"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { upsertPartnerAction } from "@/app/(superadmin)/superadmin/settings/socios/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBanner } from "@/components/ui/status-banner";
import type { Partner } from "@/lib/partners/queries";

// Sem `partner` cadastra um sócio novo; com `partner` edita. O percentual vai como texto (numeric(5,2) sem perda).
export function PartnerForm({ partner }: { partner?: Partner }) {
	const router = useRouter();
	const id = partner?.id ?? "new";
	const [name, setName] = useState(partner?.name ?? "");
	const [walletId, setWalletId] = useState(partner?.asaasWalletId ?? "");
	const [pct, setPct] = useState(partner ? partner.pct.replace(".", ",") : "");
	const [active, setActive] = useState(partner?.active ?? true);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [isPending, startTransition] = useTransition();

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		setSaved(false);
		startTransition(async () => {
			const res = await upsertPartnerAction({
				id: partner?.id,
				name,
				asaasWalletId: walletId,
				pct: pct.trim().replace(",", "."),
				active,
			});
			if (res.error) return setError(res.error);
			setError(null);
			setSaved(true);
			if (!partner) {
				setName("");
				setWalletId("");
				setPct("");
			}
			router.refresh();
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-lg">{partner ? partner.name : "Novo sócio"}</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} className="space-y-4" noValidate>
					<div className="grid gap-4 sm:grid-cols-3">
						<Field id={`partner-name-${id}`} label="Nome">
							{(a11y) => <Input {...a11y} value={name} onChange={(e) => setName(e.target.value)} disabled={isPending} maxLength={120} />}
						</Field>
						<Field id={`partner-wallet-${id}`} label="walletId do Asaas">
							{(a11y) => (
								<Input {...a11y} value={walletId} onChange={(e) => setWalletId(e.target.value)} disabled={isPending} autoComplete="off" spellCheck={false} />
							)}
						</Field>
						<Field id={`partner-pct-${id}`} label="Percentual (%)" helper="De 0,01 a 100, até 2 casas. Sobre o valor líquido.">
							{(a11y) => <Input {...a11y} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} disabled={isPending} />}
						</Field>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox id={`partner-active-${id}`} checked={active} onCheckedChange={(v) => setActive(v === true)} disabled={isPending} />
						<Label htmlFor={`partner-active-${id}`}>Ativo (recebe o split)</Label>
					</div>
					{error && <StatusBanner tone="danger" title={error} />}
					{saved && !error && <StatusBanner tone="success" title="Sócio salvo." />}
					<Button type="submit" disabled={isPending}>
						{isPending ? "Salvando..." : partner ? "Salvar" : "Cadastrar"}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
