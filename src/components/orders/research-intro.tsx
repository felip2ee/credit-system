"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

// Link "O que é uma pesquisa?": abre a explicação em um diálogo, sem tirar o usuário do passo.
export function ResearchIntro() {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button type="button" variant="link" className="h-auto min-h-11 px-0" onClick={() => setOpen(true)}>
				O que é uma pesquisa?
			</Button>
			<Dialog open={open} onClose={() => setOpen(false)} title="O que é uma pesquisa?">
				<ul className="space-y-2 text-base">
					<li>Um diagnóstico de crédito de uma pessoa ou empresa: dívidas e histórico no sistema financeiro.</li>
					<li>Antes, você autoriza a consulta. Ela é só do seu CPF ou dos CNPJs das suas empresas.</li>
					<li>Depois, você vê o relatório na tela e em PDF. Avisamos por e-mail e WhatsApp.</li>
					<li>O valor sai do seu saldo só quando a consulta roda.</li>
				</ul>
				<Button type="button" className="w-full" onClick={() => setOpen(false)}>
					Entendi
				</Button>
			</Dialog>
		</>
	);
}
