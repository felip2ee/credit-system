import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/pool", () => ({ pool: { query } }));

// Estado do módulo (mapa e timer) é por import: cada teste carrega uma cópia nova.
const load = async () => {
	vi.resetModules();
	return import("./visit-buffer");
};

beforeEach(() => {
	vi.useFakeTimers();
	query.mockReset();
	query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("visit buffer", () => {
	it("accumulates per slug without touching the database", async () => {
		const { bufferBureauVisit } = await load();
		bufferBureauVisit("a");
		bufferBureauVisit("a");
		bufferBureauVisit("b");
		expect(query).not.toHaveBeenCalled();
	});

	it("flushes once per slug with the accumulated count after the interval", async () => {
		const { bufferBureauVisit } = await load();
		bufferBureauVisit("a");
		bufferBureauVisit("a");
		bufferBureauVisit("b");
		await vi.advanceTimersByTimeAsync(9_999);
		expect(query).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls.map((c) => c[1])).toEqual([["a", 2], ["b", 1]]);
		// Nada novo, nada mais gravado.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("keeps the counts when the flush fails and retries on the next interval, without logging the slug", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		query.mockRejectedValueOnce(new Error("db down"));
		const { bufferBureauVisit } = await load();
		bufferBureauVisit("a");
		bufferBureauVisit("a");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(error).toHaveBeenCalledWith("flushBureauVisits failed", "db down");
		bufferBureauVisit("a");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[1][1]).toEqual(["a", 3]);
	});

	it("ignores new slugs above the cap but still counts buffered ones", async () => {
		const { bufferBureauVisit, flushBureauVisits } = await load();
		for (let i = 0; i < 250; i++) bufferBureauVisit(`s${i}`);
		bufferBureauVisit("s0");
		await flushBureauVisits();
		expect(query).toHaveBeenCalledTimes(200);
		expect(query.mock.calls.find((c) => c[1][0] === "s0")?.[1]).toEqual(["s0", 2]);
		expect(query.mock.calls.some((c) => c[1][0] === "s200")).toBe(false);
	});

	it("writes at most 50 visits per slug per flush", async () => {
		const { bufferBureauVisit, flushBureauVisits } = await load();
		for (let i = 0; i < 80; i++) bufferBureauVisit("a");
		await flushBureauVisits();
		expect(query.mock.calls[0][1]).toEqual(["a", 50]);
	});

	it("does not start a second flush while one is running", async () => {
		let release: () => void = () => {};
		query.mockReturnValueOnce(new Promise((resolve) => (release = () => resolve({ rows: [] }))));
		const { bufferBureauVisit, flushBureauVisits } = await load();
		bufferBureauVisit("a");
		const first = flushBureauVisits();
		bufferBureauVisit("b");
		await flushBureauVisits();
		expect(query).toHaveBeenCalledTimes(1);
		release();
		await first;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(query).toHaveBeenCalledTimes(2);
	});
});
