import { Download } from "lucide-react";

import { ConsultationResult, ConsultationUnavailable } from "@/components/consultations/consultation-result";
import { MarkdownReport } from "@/components/shared/markdown-report";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toConsultationView } from "@/lib/consultations/view-model";
import type { ClientDelivery } from "@/lib/orders/client-queries";
import type { Parecer } from "@/types/ai";

const APTITUDE: Record<Parecer["apto"], { label: string; variant: BadgeProps["variant"] }> = {
	apto: { label: "Apto", variant: "success" },
	apto_com_ressalvas: { label: "Apto com ressalvas", variant: "secondary" },
	inapto: { label: "Inapto", variant: "destructive" },
};

// Parecer só para leitura: sem botões de gerar ou regenerar.
function OpinionReadOnly({ title, parecer }: { title: string; parecer: Parecer }) {
	const apt = APTITUDE[parecer.apto];
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle className="text-lg">{title}</CardTitle>
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={apt.variant}>{apt.label}</Badge>
					<Badge variant="outline">{parecer.classificacao_perfil}</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-sm text-muted-foreground">{parecer.resumo_executivo}</p>
				<details className="rounded-md border">
					<summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">Ver parecer técnico completo</summary>
					<div className="border-t px-4 py-3 text-sm text-muted-foreground">
						<MarkdownReport>{parecer.relatorio_markdown}</MarkdownReport>
					</div>
				</details>
				<p className="border-t pt-3 text-[11px] text-muted-foreground">{parecer.disclaimer}</p>
			</CardContent>
		</Card>
	);
}

export function DeliveryView({ delivery }: { delivery: ClientDelivery }) {
	const { order, members, dossierOpinion } = delivery;
	return (
		<div className="space-y-6">
			<div className="flex justify-end">
				<Button asChild variant="outline">
					<a href={`/portal/pesquisas/${order.dossierId}/pdf`}>
						<Download className="h-4 w-4" />
						Baixar PDF
					</a>
				</Button>
			</div>
			{members.map((m) => (
				<section key={m.consultationId} aria-label={m.name ?? "Consulta"} className="space-y-4">
					<h2 className="text-lg font-semibold">
						{m.name ?? "Consulta"} <span className="text-sm font-normal text-muted-foreground">({m.type})</span>
					</h2>
					{m.canonical ? (
						<ConsultationResult view={toConsultationView(m.canonical)} />
					) : (
						<ConsultationUnavailable consultationId={m.consultationId} message="Resultado indisponível para esta consulta." />
					)}
					{m.opinion && <OpinionReadOnly title="Parecer de IA" parecer={m.opinion} />}
				</section>
			))}
			{dossierOpinion && <OpinionReadOnly title="Parecer consolidado" parecer={dossierOpinion} />}
		</div>
	);
}
