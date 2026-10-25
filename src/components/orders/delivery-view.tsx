import { Download } from "lucide-react";

import { ConsultationResult, ConsultationUnavailable } from "@/components/consultations/consultation-result";
import { FullConsultationResult } from "@/components/consultations/full-consultation-result";
import { MarkdownReport } from "@/components/shared/markdown-report";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StateTone } from "@/components/ui/state-tone";
import { FULL_DATA_UNAVAILABLE, toConsultationContent } from "@/lib/consultations/full-view";
import type { ClientDelivery } from "@/lib/orders/client-queries";
import type { Parecer } from "@/types/ai";

const APTITUDE: Record<Parecer["apto"], { label: string; tone: StateTone }> = {
	apto: { label: "Apto", tone: "success" },
	apto_com_ressalvas: { label: "Apto com ressalvas", tone: "attention" },
	inapto: { label: "Inapto", tone: "danger" },
};

// Parecer só para leitura: sem botões de gerar ou regenerar.
function OpinionReadOnly({ title, parecer }: { title: string; parecer: Parecer }) {
	const apt = APTITUDE[parecer.apto];
	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
				<CardTitle className="text-xl">{title}</CardTitle>
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge tone={apt.tone} label={apt.label} />
					<Badge variant="outline">{parecer.classificacao_perfil}</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-base text-muted-foreground">{parecer.resumo_executivo}</p>
				<details className="rounded-input border border-input">
					<summary className="cursor-pointer select-none px-4 py-2 text-base font-medium">Ver parecer técnico completo</summary>
					<div className="border-t border-border px-4 py-3 text-base text-muted-foreground">
						<MarkdownReport>{parecer.relatorio_markdown}</MarkdownReport>
					</div>
				</details>
				<p className="border-t border-border pt-3 text-base text-muted-foreground">{parecer.disclaimer}</p>
			</CardContent>
		</Card>
	);
}

// Só consulta concluída mostra conteúdo; o rodapé técnico (meta) fica só com a equipe.
function forClient(member: ClientDelivery["members"][number]) {
	if (member.status !== "completed") return { full: null, view: null };
	const content = toConsultationContent(member.payload, member.canonical);
	return { ...content, full: content.full && { ...content.full, meta: [] } };
}

function MemberResult({ member }: { member: ClientDelivery["members"][number] }) {
	const content = forClient(member);
	if (content.full) return <FullConsultationResult view={content.full} />;
	if (content.view) {
		return (
			<>
				<p className="text-base text-muted-foreground">{FULL_DATA_UNAVAILABLE}</p>
				<ConsultationResult view={content.view} />
			</>
		);
	}
	return <ConsultationUnavailable consultationId={member.consultationId} message="Resultado indisponível para esta consulta." />;
}

export function DeliveryView({ delivery }: { delivery: ClientDelivery }) {
	const { order, members, dossierOpinion } = delivery;
	return (
		<div className="space-y-6">
			<div className="flex sm:justify-end">
				<Button asChild glow className="w-full sm:w-auto">
					<a href={`/portal/pesquisas/${order.dossierId}/pdf`}>
						<Download aria-hidden />
						Baixar PDF
					</a>
				</Button>
			</div>
			{members.map((m) => (
				<section key={m.consultationId} aria-label={m.name ?? "Consulta"} className="space-y-4">
					<h2 className="text-xl font-semibold">
						{m.name ?? "Consulta"} <span className="text-base font-normal text-muted-foreground">({m.type})</span>
					</h2>
					<MemberResult member={m} />
					{m.opinion && <OpinionReadOnly title="Parecer de IA" parecer={m.opinion} />}
				</section>
			))}
			{dossierOpinion && <OpinionReadOnly title="Parecer consolidado" parecer={dossierOpinion} />}
		</div>
	);
}
