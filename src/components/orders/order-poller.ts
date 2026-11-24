import type { OrderState } from "@/lib/orders/types";

export const POLL_INTERVAL_MS = 1000;
export const HIDDEN_INTERVAL_MS = 10_000;
export const ERROR_BACKOFF_START_MS = 2000;
export const ERROR_BACKOFF_MAX_MS = 30_000;

// completed não é final: ainda falta liberar a entrega.
const FINAL_STATES: readonly OrderState[] = ["released", "failed", "cancelled"];
export const isFinalOrderState = (state: OrderState) => FINAL_STATES.includes(state);

// status é o HTTP; state só vem quando a resposta é válida. Erro de rede: lança.
export type StatusResult = { status: number; state?: OrderState };

export interface PollerDeps {
	fetchStatus: () => Promise<StatusResult>;
	refresh: () => void;
	isHidden: () => boolean;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

// Consulta o estado do pedido em cadeia (nunca duas requisições juntas) e chama refresh só quando ele muda.
export function createOrderPoller(initialState: OrderState, deps: PollerDeps) {
	let last = initialState;
	let timer: unknown = null;
	let inFlight = false;
	let stopped = isFinalOrderState(initialState);
	let failures = 0;

	const schedule = (ms: number) => {
		if (stopped) return;
		timer = deps.setTimer(() => void tick(), ms);
	};
	const clear = () => {
		if (timer !== null) deps.clearTimer(timer);
		timer = null;
	};

	async function tick() {
		timer = null;
		if (stopped || inFlight) return;
		inFlight = true;
		let delay: number;
		try {
			const res = await deps.fetchStatus();
			if (res.status === 401 || res.status === 404) {
				stopped = true;
				return;
			}
			if (res.status !== 200 || !res.state) throw new Error("status inválido");
			failures = 0;
			if (res.state !== last) {
				last = res.state;
				deps.refresh();
				if (isFinalOrderState(last)) stopped = true;
			}
			delay = deps.isHidden() ? HIDDEN_INTERVAL_MS : POLL_INTERVAL_MS;
		} catch {
			failures += 1;
			delay = Math.min(ERROR_BACKOFF_START_MS * 2 ** (failures - 1), ERROR_BACKOFF_MAX_MS);
		} finally {
			inFlight = false;
		}
		schedule(delay);
	}

	return {
		start() {
			if (!stopped && timer === null && !inFlight) schedule(deps.isHidden() ? HIDDEN_INTERVAL_MS : POLL_INTERVAL_MS);
		},
		// Aba voltou a ficar visível: consulta já, sem esperar o intervalo lento.
		wake() {
			if (stopped || inFlight) return;
			clear();
			void tick();
		},
		stop() {
			stopped = true;
			clear();
		},
	};
}
