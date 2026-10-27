"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PORTAL_BALANCE_HIDDEN_KEY as STORAGE_KEY } from "@/components/ui/balance";


export function BalanceChip({ value }: { value: string }) {
	const [hidden, setHidden] = useState(false);

	useEffect(() => {
		try {
			setHidden(localStorage.getItem(STORAGE_KEY) === "1");
		} catch {
			// localStorage indisponível: saldo fica visível.
		}
	}, []);

	function toggle() {
		const next = !hidden;
		setHidden(next);
		try {
			localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
		} catch {
			// Sem persistência: vale só nesta página.
		}
	}

	const Icon = hidden ? Eye : EyeOff;
	return (
		<div className="ml-auto flex min-h-12 min-w-0 items-center gap-1 rounded-full bg-brand-soft pl-4 pr-1 text-brand-soft-foreground">
			<Link
				href="/portal/credits"
				aria-label={hidden ? "Saldo oculto, abrir Créditos" : `Abrir Créditos, saldo ${value}`}
				className="flex min-h-11 min-w-0 items-center truncate text-lg font-bold tabular-nums">
				{hidden ? "R$ ••••" : value}
			</Link>
			<button
				type="button"
				onClick={toggle}
				aria-label={hidden ? "Mostrar saldo" : "Ocultar saldo"}
				className="flex size-11 shrink-0 items-center justify-center rounded-full"
			>
				<Icon className="size-5" aria-hidden="true" />
			</button>
		</div>
	);
}
