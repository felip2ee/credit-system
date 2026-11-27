"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauWalletIdAction } from "@/actions/bureau-wallet";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";

// walletId do Asaas que recebe a parte do Bureau no split. Sem walletId, a parte vira repasse manual.
export function BureauWalletForm({ bureauId, walletIdMasked, canWrite }: { bureauId: string; walletIdMasked: string | null; canWrite: boolean }) {
	const router = useRouter();
	const [walletId, setWalletId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		setSaved(null);
		// Em branco mantém o walletId salvo: nada a gravar.
		if (!walletId.trim() && walletIdMasked) {
			setError(null);
			return setSaved("walletId mantido.");
		}
		startTransition(async () => {
			const res = await setBureauWalletIdAction({ bureauId, asaasWalletId: walletId });
			if (res.error) return setError(res.error);
			setError(null);
			setSaved("walletId salvo.");
			setWalletId("");
			router.refresh();
		});
	};

	return (
		<form onSubmit={submit} className="space-y-3" noValidate>
			<Field
				id="bureau-wallet-id"
				label="walletId do Asaas"
				helper={
					walletIdMasked
						? `ID salvo: ${walletIdMasked}. Deixe em branco para manter.`
						: "Conta que recebe a parte do Bureau no split. Sem walletId, a parte fica como repasse manual."
				}
			>
				{(a11y) => (
					<Input
						{...a11y}
						value={walletId}
						onChange={(e) => setWalletId(e.target.value)}
						placeholder="00000000-0000-0000-0000-000000000000"
						disabled={isPending || !canWrite}
						autoComplete="off"
						spellCheck={false}
					/>
				)}
			</Field>
			{error && <StatusBanner tone="danger" title={error} />}
			{saved && !error && <StatusBanner tone="success" title={saved} />}
			{canWrite && (
				<Button type="submit" disabled={isPending}>
					{isPending ? "Salvando..." : "Salvar walletId"}
				</Button>
			)}
		</form>
	);
}
