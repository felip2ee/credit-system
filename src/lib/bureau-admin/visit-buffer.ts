// Visitas da página pública /b/<slug>: contadas em memória e gravadas em lote, fora do caminho de render.
// Sem isso, cada GET faria um upsert na mesma linha (bureau_id, dia) e uma enxurrada de acessos
// serializaria na trava da linha segurando conexões do pool.
import { pool } from "@/lib/db/pool";

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFERED_SLUGS = 200;
// shortcut: record_bureau_page_view_by_slug soma 1 por chamada (sem migration), então cada gravação conta
// no máximo 50 visitas por slug; o excedente do intervalo é descartado. Trocar por uma função SQL "+n" se a contagem exata importar.
const MAX_VISITS_PER_FLUSH = 50;

const pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function add(slug: string, count: number): void {
	const current = pending.get(slug);
	// Teto de slugs em memória: slug novo além do teto é ignorado.
	if (current === undefined && pending.size >= MAX_BUFFERED_SLUGS) return;
	pending.set(slug, (current ?? 0) + count);
}

function schedule(): void {
	if (timer) return;
	timer = setTimeout(() => {
		timer = null;
		void flushBureauVisits();
	}, FLUSH_INTERVAL_MS);
	timer.unref();
}

// Chamar só com slug que resolveu para um Bureau ativo. Síncrona: nunca espera o banco.
export function bufferBureauVisit(slug: string): void {
	add(slug, 1);
	schedule();
}

export async function flushBureauVisits(): Promise<void> {
	if (flushing) return;
	flushing = true;
	try {
		for (const [slug, count] of Array.from(pending)) {
			// Tira da fila antes do await: visitas que chegam durante a gravação acumulam à parte.
			pending.delete(slug);
			try {
				await pool.query("select record_bureau_page_view_by_slug($1) from generate_series(1, $2::int)", [
					slug,
					Math.min(count, MAX_VISITS_PER_FLUSH),
				]);
			} catch (error) {
				console.error("flushBureauVisits failed", error instanceof Error ? error.message : "unknown error");
				add(slug, count);
			}
		}
	} finally {
		flushing = false;
		if (pending.size > 0) schedule();
	}
}
