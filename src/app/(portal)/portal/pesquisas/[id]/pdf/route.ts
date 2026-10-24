import { getOwnBureauName } from "@/lib/bureaus/queries";
import { BRAND_NAME } from "@/lib/brand/brand";
import { config } from "@/lib/config";
import { getRequiredSession } from "@/lib/auth/session";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "@/lib/deps/products";
import { maskDocument } from "@/lib/mask-document";
import { getMyDelivery } from "@/lib/orders/client-queries";
import { renderDossierPdf, type DossierEntry } from "@/lib/pdf/dossier-document";
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
		// Só consulta concluída entrega conteúdo ao cliente; o rodapé técnico (meta) fica só com a equipe.
		if (m.status !== "completed") continue;
		const raw = toConsultationContent(m.payload, m.canonical);
		if (!raw.full && !raw.view) continue;
		const content = { ...raw, full: raw.full && { ...raw.full, meta: [] } };
		const header: FullPdfHeader = {
			name: m.name ?? content.view?.subject.name ?? "—",
			cpf: m.canonical ? maskDocument(m.type, m.canonical.document.value) : "—",
			docLabel: content.view?.subject.documentLabel ?? (m.type === "PJ" ? "CNPJ" : "CPF"),
			produto: m.product ?? (m.type === "PJ" ? DEPS_PRODUCT_PJ : DEPS_PRODUCT_PF),
			data: (order.releasedAt ?? order.createdAt).toLocaleString("pt-BR"),
			consultante: BRAND_NAME,
			usuario: session.userId,
			endereco: content.view?.subject.location ?? undefined,
		};
		entries.push({ content, header, role: m.type === "PJ" ? "Empresa" : kind === "PF" ? "Titular" : "Sócio" });
	}
	if (entries.length === 0) return new Response("A entrega ainda não tem resultado para gerar o PDF.", {
			status: 409,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});

	// PJ_FULL leva o parecer consolidado; PF e PJ levam o parecer da própria consulta.
	const parecer = delivery.dossierOpinion ?? members.find((m) => m.opinion)?.opinion ?? null;
	const frame = { bureauName: (await getOwnBureauName(session)) ?? BRAND_NAME, supportEmail: config.supportEmail, issuedAt: new Date() };
	const pdf = await renderDossierPdf(
		{
			title: order.subjectName,
			subtitle: `${order.subjectDocumentMasked} · ${entries.length} consulta(s)`,
			entries,
			report: parecer ? toOpinion(parecer) : null,
		},
		frame,
	);

	return new Response(new Uint8Array(pdf), {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="pesquisa-${params.id.slice(0, FILENAME_ID_LENGTH)}.pdf"`,
			"Cache-Control": "no-store, must-revalidate",
		},
	});
}
