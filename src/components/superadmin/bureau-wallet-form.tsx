"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setBureauWalletIdAction } from "@/actions/bureau-wallet";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";

// walletId do Asaas que recebe a parte do Bureau no split. Sem walletId, a parte vira repasse manual.
export function BureauWalletForm({ bureauId, initialWalletId, canWrite }: { bureauId: string; initialWalletId: string | null; canWrite: boolean }) {
	const router = useRouter();
	const [walletId, setWalletId] = useState(initialWalletId ?? "");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [isPending, startTransition] = useTransition();

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		setSaved(false);
		startTransition(async () => {
			const res = await setBureauWalletIdAction({ bureauId, asaasWalletId: walletId });
			if (res.error) return setError(res.error);
			setError(null);
			setSaved(true);
			router.refresh();
		});
	};

	return (
		<form onSubmit={submit} className="space-y-3" noValidate>
			<Field
				id="bureau-wallet-id"
				label="walletId do Asaas"
				helper="Conta que recebe a parte do Bureau no split. Sem walletId, a parte fica como repasse manual."
			>
				{(a11y) => (
					<Input
						{...a11y}
						value={walletId}
						onChange={(e) => setWalletId(e.target.value)}
						disabled={isPending || !canWrite}
						autoComplete="off"
						spellCheck={false}
					/>
				)}
			</Field>
			{error && <StatusBanner tone="danger" title={error} />}
			{saved && !error && <StatusBanner tone="success" title="walletId salvo." />}
			{canWrite && (
				<Button type="submit" disabled={isPending}>
					{isPending ? "Salvando..." : "Salvar walletId"}
				</Button>
			)}
		</form>
	);
}
