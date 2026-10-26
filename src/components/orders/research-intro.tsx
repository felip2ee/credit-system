"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

const STORAGE_KEY = "portal:research-intro-closed";

export function ResearchIntro() {
	const [open, setOpen] = useState(true);

	useEffect(() => {
		try {
			if (localStorage.getItem(STORAGE_KEY) === "1") setOpen(false);
		} catch {
			// Sem armazenamento: fica aberto.
		}
	}, []);

	const toggle = (next: boolean) => {
		setOpen(next);
		try {
			localStorage.setItem(STORAGE_KEY, next ? "0" : "1");
		} catch {
			// Preferência não salva; sem efeito no pedido.
		}
	};

	return (
		<details
			open={open}
			onToggle={(e) => {
				const next = e.currentTarget.open;
				if (next !== open) toggle(next);
			}}
			className="group rounded-card bg-brand-soft p-4"
		>
			<summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 font-bold">
				O que é uma pesquisa?
				<ChevronDown aria-hidden className="size-5 shrink-0 transition-transform group-open:rotate-180" />
			</summary>
			<ul className="mt-2 space-y-2 text-base">
				<li>Um diagnóstico de crédito de uma pessoa ou empresa: dívidas e histórico no sistema financeiro.</li>
				<li>Antes, você autoriza a consulta. Ela é só do seu CPF ou dos CNPJs das suas empresas.</li>
				<li>Depois, você vê o relatório na tela e em PDF. Avisamos por e-mail e WhatsApp.</li>
				<li>O valor sai do seu saldo só quando a consulta roda.</li>
			</ul>
		</details>
	);
}
