import { describe, expect, it } from "vitest";

import { assertCursor } from "./cursor";
import { parseSalesCursor } from "./sales";

const ID = "00000000-0000-4000-8000-000000000001";

describe("assertCursor", () => {
	it("accepts Postgres text and ISO instants", () => {
		expect(() => assertCursor("2026-10-10 12:00:00.123456+00", ID)).not.toThrow();
		expect(() => assertCursor("2026-10-10 12:00:00-03", ID)).not.toThrow();
		expect(() => assertCursor("2026-10-10T12:00:00.123456Z", ID)).not.toThrow();
	});

	it("rejects impossible dates", () => {
		expect(() => assertCursor("2026-13-10 12:00:00+00", ID)).toThrow(RangeError);
		expect(() => assertCursor("2026-02-30 12:00:00+00", ID)).toThrow(RangeError);
		expect(() => assertCursor("2026-10-10 25:00:00+00", ID)).toThrow(RangeError);
	});

	it("rejects a malformed uuid", () => {
		expect(() => assertCursor("2026-10-10 12:00:00+00", "-".repeat(36))).toThrow(RangeError);
		expect(() => assertCursor("2026-10-10 12:00:00+00", "g0000000-0000-4000-8000-000000000001")).toThrow(RangeError);
	});
});

describe("parseSalesCursor", () => {
	it("accepts a well-formed cursor and treats empty as no cursor", () => {
		expect(parseSalesCursor(`2026-10-10 12:00:00.123456+00|${ID}`)).toEqual({ at: "2026-10-10 12:00:00.123456+00", orderRef: ID });
		expect(parseSalesCursor(null)).toBeNull();
		expect(parseSalesCursor(undefined)).toBeNull();
		expect(parseSalesCursor("")).toBeNull();
	});

	it("throws RangeError for tampered text, month 13 and a dashes-only uuid", () => {
		expect(() => parseSalesCursor("x'; drop table|y")).toThrow(RangeError);
		expect(() => parseSalesCursor(`2026-13-10 12:00:00+00|${ID}`)).toThrow(RangeError);
		expect(() => parseSalesCursor(`2026-10-10 12:00:00+00|${"-".repeat(36)}`)).toThrow(RangeError);
	});
});
