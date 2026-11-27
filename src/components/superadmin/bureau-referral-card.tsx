"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { clearBureauReferrerAction, setBureauReferrerAction } from "@/app/(superadmin)/superadmin/bureaus/[id]/referral-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBanner } from "@/components/ui/status-banner";

type Candidate = { id: string; name: string };

// Bureau indicador: recebe a % da comissão deste bureau em cada entrada. Um indicador por bureau; para trocar, remova o atual.
export function BureauReferralCard({
	bureauId,
	current,
	candidates,
	canWrite,
}: {
	bureauId: string;
	current: { referrerName: string; pct: string } | null;
	candidates: Candidate[];
	canWrite: boolean;
}) {
	const router = useRouter();
	const [referrerId, setReferrerId] = useState("");
	const [pct, setPct] = useState("5");
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	const run = (work: () => Promise<{ error: string | null }>) =>
		startTransition(async () => {
			const res = await work();
			setError(res.error);
			if (!res.error) {
				setReferrerId("");
				router.refresh();
			}
		});

	const save = (event: React.FormEvent) => {
		event.preventDefault();
		if (!referrerId) return setError("Escolha o bureau indicador.");
		run(() => setBureauReferrerAction({ referredBureauId: bureauId, referrerBureauId: referrerId, pct }));
	};
	const remove = () => run(() => clearBureauReferrerAction({ referredBureauId: bureauId }));

	return (
		<div className="space-y-3">
			{current ? (
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<span>
						Indicador: <strong>{current.referrerName}</strong>, recebe {Number(current.pct).toLocaleString("pt-BR")}% das entradas.
					</span>
					{canWrite && (
						<Button type="button" variant="outline" onClick={remove} disabled={isPending}>
							{isPending ? "Removendo..." : "Remover indicador"}
						</Button>
					)}
				</div>
			) : canWrite ? (
				<form onSubmit={save} className="space-y-3" noValidate>
					<Field id="referrer-bureau" label="Quem indica este bureau" helper="O indicador recebe a % abaixo em cada entrada deste bureau.">
						{(a11y) => (
							<Select value={referrerId} onValueChange={setReferrerId} disabled={isPending}>
								<SelectTrigger {...a11y}>
									<SelectValue placeholder="Escolha um bureau" />
								</SelectTrigger>
								<SelectContent>
									{candidates.map((c) => (
										<SelectItem key={c.id} value={c.id}>
											{c.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					<Field id="referrer-pct" label="Porcentagem do indicador (%)">
						{(a11y) => (
							<Input {...a11y} value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" disabled={isPending} autoComplete="off" />
						)}
					</Field>
					<Button type="submit" disabled={isPending}>
						{isPending ? "Salvando..." : "Salvar indicador"}
					</Button>
				</form>
			) : (
				<p className="text-sm text-muted-foreground">Sem indicador.</p>
			)}
			{error && <StatusBanner tone="danger" title={error} />}
		</div>
	);
}
