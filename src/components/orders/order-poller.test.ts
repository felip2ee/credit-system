import { describe, expect, it, vi } from "vitest";

import type { OrderState } from "@/lib/orders/types";

import {
	createOrderPoller,
	ERROR_BACKOFF_MAX_MS,
	ERROR_BACKOFF_START_MS,
	HIDDEN_INTERVAL_MS,
	POLL_INTERVAL_MS,
	type StatusResult,
} from "./order-poller";

// Relógio manual: guarda um timer por vez e o executa sob demanda.
function setup(initial: OrderState, responses: (StatusResult | Error)[] = []) {
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let nextId = 1;
	let hidden = false;
	const fetchStatus = vi.fn(async () => {
		const next = responses.shift();
		if (!next) throw new Error("sem resposta");
		if (next instanceof Error) throw next;
		return next;
	});
	const refresh = vi.fn();
	const poller = createOrderPoller(initial, {
		fetchStatus,
		refresh,
		isHidden: () => hidden,
		setTimer: (fn, ms) => {
			timers.set(nextId, { fn, ms });
			return nextId++;
		},
		clearTimer: (h) => void timers.delete(h as number),
	});
	const pending = () => Array.from(timers.values());
	const fire = async () => {
		const [id, t] = Array.from(timers.entries())[0];
		timers.delete(id);
		t.fn();
		await vi.waitFor(() => undefined);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { poller, fetchStatus, refresh, pending, fire, setHidden: (v: boolean) => (hidden = v) };
}

const ok = (state: OrderState): StatusResult => ({ status: 200, state });

describe("createOrderPoller", () => {
	it("does not poll when the initial state is final", () => {
		for (const s of ["released", "failed", "cancelled"] as const) {
			const t = setup(s);
			t.poller.start();
			expect(t.pending()).toHaveLength(0);
		}
	});

	it("polls on completed, which is not final", async () => {
		const t = setup("completed", [ok("completed")]);
		t.poller.start();
		expect(t.pending()[0].ms).toBe(POLL_INTERVAL_MS);
		await t.fire();
		expect(t.fetchStatus).toHaveBeenCalledTimes(1);
		expect(t.pending()).toHaveLength(1);
	});

	it("refreshes only when the state changes, and stops at a final state", async () => {
		const t = setup("ready", [ok("ready"), ok("executing"), ok("executing"), ok("completed"), ok("released")]);
		t.poller.start();
		await t.fire();
		expect(t.refresh).not.toHaveBeenCalled();
		await t.fire();
		expect(t.refresh).toHaveBeenCalledTimes(1);
		await t.fire();
		expect(t.refresh).toHaveBeenCalledTimes(1);
		await t.fire();
		expect(t.refresh).toHaveBeenCalledTimes(2);
		await t.fire();
		expect(t.refresh).toHaveBeenCalledTimes(3);
		expect(t.pending()).toHaveLength(0);
	});

	it("slows down while hidden and checks at once when visible again", async () => {
		const t = setup("ready", [ok("ready"), ok("ready"), ok("executing")]);
		t.poller.start();
		t.setHidden(true);
		await t.fire();
		expect(t.pending()[0].ms).toBe(HIDDEN_INTERVAL_MS);

		t.setHidden(false);
		t.poller.wake();
		await Promise.resolve();
		await Promise.resolve();
		expect(t.fetchStatus).toHaveBeenCalledTimes(2);
		expect(t.pending()).toHaveLength(1);
		expect(t.pending()[0].ms).toBe(POLL_INTERVAL_MS);
	});

	it("never sends overlapping requests", async () => {
		let release: (r: StatusResult) => void = () => undefined;
		const timers: (() => void)[] = [];
		const fetchStatus = vi.fn(() => new Promise<StatusResult>((resolve) => (release = resolve)));
		const poller = createOrderPoller("ready", {
			fetchStatus,
			refresh: vi.fn(),
			isHidden: () => false,
			setTimer: (fn) => timers.push(fn),
			clearTimer: () => undefined,
		});
		poller.start();
		timers[0]();
		poller.wake();
		poller.wake();
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		release(ok("ready"));
		await Promise.resolve();
		await Promise.resolve();
		expect(timers).toHaveLength(2);
	});

	it.each([401, 404])("stops on %i", async (status) => {
		const t = setup("ready", [{ status }]);
		t.poller.start();
		await t.fire();
		expect(t.pending()).toHaveLength(0);
		expect(t.refresh).not.toHaveBeenCalled();
	});

	it("backs off on network or server errors and recovers", async () => {
		const t = setup("ready", [new Error("net"), { status: 500 }, new Error("net"), ok("ready")]);
		t.poller.start();
		await t.fire();
		expect(t.pending()[0].ms).toBe(ERROR_BACKOFF_START_MS);
		await t.fire();
		expect(t.pending()[0].ms).toBe(ERROR_BACKOFF_START_MS * 2);
		await t.fire();
		expect(t.pending()[0].ms).toBe(ERROR_BACKOFF_START_MS * 4);
		await t.fire();
		expect(t.pending()[0].ms).toBe(POLL_INTERVAL_MS);
	});

	it("caps the error backoff", async () => {
		const t = setup("ready", Array.from({ length: 8 }, () => new Error("net")));
		t.poller.start();
		for (let i = 0; i < 8; i++) await t.fire();
		expect(t.pending()[0].ms).toBe(ERROR_BACKOFF_MAX_MS);
	});

	it("stop clears the timer and prevents more polling", async () => {
		const t = setup("ready", [ok("ready")]);
		t.poller.start();
		t.poller.stop();
		expect(t.pending()).toHaveLength(0);
		t.poller.wake();
		expect(t.fetchStatus).not.toHaveBeenCalled();
	});
});
