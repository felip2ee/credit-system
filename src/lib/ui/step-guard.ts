// Um duplo clique em "Continuar" não pode atravessar a etapa seguinte, nem confirmar uma ação com dinheiro.
export const STEP_CLICK_GUARD_MS = 600;

export function isStepSettled(changedAtMs: number, nowMs: number): boolean {
	return nowMs - changedAtMs >= STEP_CLICK_GUARD_MS;
}
