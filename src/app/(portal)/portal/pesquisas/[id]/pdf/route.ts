import { getRequiredSession } from "@/lib/auth/session";
import { toConsultationView, formatSubjectDocument } from "@/lib/consultations/view-model";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { getMyDelivery } from "@/lib/orders/client-queries";
import { renderDossierPdf, type DossierEntry } from "@/lib/pdf/dossier-document";
import { letterheadDataUri } from "@/lib/pdf/letterhead";
import type { FullPdfHeader } from "@/lib/pdf/consultation-full-document";
import type { OpinionForPdf } from "@/lib/pdf/markdown-pdf";
import { isUuid } from "@/lib/validators/id";
import { toAptitudeStatus, type Parecer } from "@/types/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILENAME_ID_LENGTH = 8;

function toOpinion(parecer: Parecer): OpinionForPdf {
	return {
		aptitude: toAptitudeStatus(parecer.apto),
		classificacao: parecer.classificacao_perfil,
		resumo: parecer.resumo_executivo,
		pontosFortes: parecer.pontos_fortes,
		pontosAtencao: parecer.pontos_atencao,
		planoAcao: parecer.plano_acao,
		limiteSugerido: parecer.limite_sugerido,
		limiteNotas: parecer.limite_sugerido_notas,
		relatorioMarkdown: parecer.relatorio_markdown,
	};
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
	let session;
	try {
		session = await getRequiredSession();
	} catch {
		return new Response("Sessão expirada.", { status: 401 });
	}
	if (session.role !== "client" || !hasPermission(session, "portal:read")) {
		return new Response("Sem permissão.", { status: 403 });
	}

	// Outro cliente e pedido não liberado dão o mesmo 404: a RLS e getMyDelivery só devolvem a entrega liberada.
	if (!isUuid(params.id)) return new Response("Pesquisa não encontrada.", { status: 404 });
	const delivery = await withUserTransaction(session, (client) => getMyDelivery(client, params.id));
	if (!delivery) return new Response("Pesquisa não encontrada.", { status: 404 });
	const { order, kind, members } = delivery;

	// Empresa (PJ) primeiro, depois os sócios (PF), como no PDF da equipe.
	const ordered = [...members].sort((a, b) => (a.type === b.type ? 0 : a.type === "PJ" ? -1 : 1));
	const entries: DossierEntry[] = [];
	for (const m of ordered) {
		if (!m.canonical) continue;
		const view = toConsultationView(m.canonical);
		const header: FullPdfHeader = {
			name: m.name ?? (view.subject.name || "—"),
			cpf: formatSubjectDocument(m.canonical),
			docLabel: view.subject.documentLabel,
			produto: m.product ?? (m.type === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
			data: (order.releasedAt ?? order.createdAt).toLocaleString("pt-BR"),
			consultante: "Reino do Crédito",
			usuario: session.userId,
			endereco: view.subject.location ?? undefined,
		};
		entries.push({ view, header, role: m.type === "PJ" ? "Empresa" : kind === "PF" ? "Titular" : "Sócio" });
	}
	if (entries.length === 0) return new Response("A entrega ainda não tem resultado para gerar o PDF.", {
			status: 409,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});

	// PJ_FULL leva o parecer consolidado; PF e PJ levam o parecer da própria consulta.
	const parecer = delivery.dossierOpinion ?? members.find((m) => m.opinion)?.opinion ?? null;
	const pdf = await renderDossierPdf(
		{
			title: order.subjectName,
			subtitle: `${order.subjectDocumentMasked} · ${entries.length} consulta(s)`,
			entries,
			report: parecer ? toOpinion(parecer) : null,
		},
		letterheadDataUri(),
	);

	return new Response(new Uint8Array(pdf), {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="pesquisa-${params.id.slice(0, FILENAME_ID_LENGTH)}.pdf"`,
			"Cache-Control": "no-store, must-revalidate",
		},
	});
}
