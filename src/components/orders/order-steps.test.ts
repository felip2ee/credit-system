import { describe, expect, it } from "vitest";

import { orderSteps } from "./order-steps";

const states = (steps: ReturnType<typeof orderSteps>) => steps?.map((s) => s.state);

describe("orderSteps", () => {
	it("tem os 4 passos do pedido", () => {
		expect(orderSteps("awaiting_authorization", null)?.map((s) => s.label)).toEqual(["Pedido feito", "Autorizações", "Consultando", "Pronto"]);
	});
	it("aguardando autorização: passo 2 é o atual", () => {
		expect(states(orderSteps("awaiting_authorization", null))).toEqual(["done", "current", "todo", "todo"]);
	});
	it("na fila e em consulta: passo 3 é o atual", () => {
		expect(states(orderSteps("ready", null))).toEqual(["done", "done", "current", "todo"]);
		expect(states(orderSteps("executing", null))).toEqual(["done", "done", "current", "todo"]);
	});
	it("pronto aguardando o Bureau e liberado", () => {
		expect(states(orderSteps("completed", null))).toEqual(["done", "done", "done", "current"]);
		expect(states(orderSteps("released", null))).toEqual(["done", "done", "done", "done"]);
	});
	it("autorização recusada ou vencida falha no passo 2; consulta que falha, no passo 3", () => {
		expect(states(orderSteps("failed", "scr_refused"))).toEqual(["done", "failed", "todo", "todo"]);
		expect(states(orderSteps("cancelled", "scr_expired"))).toEqual(["done", "failed", "todo", "todo"]);
		expect(states(orderSteps("failed", "deps_no_data"))).toEqual(["done", "done", "failed", "todo"]);
	});
	it("pedido cancelado por outro motivo não mostra os passos", () => {
		expect(orderSteps("cancelled", "cancelled_by_client")).toBeNull();
	});
});
