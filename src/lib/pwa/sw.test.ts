import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const ORIGIN = "https://app.example.test";
const SOURCE = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");

type Listener = (event: unknown) => void;

// Roda public/sw.js num sandbox e devolve a url que o clique abriria.
async function clickTarget(data: unknown): Promise<string | null> {
	const listeners: Record<string, Listener> = {};
	let opened: string | null = null;
	const self = {
		location: { origin: ORIGIN },
		addEventListener: (type: string, fn: Listener) => {
			listeners[type] = fn;
		},
		registration: { showNotification: () => Promise.resolve() },
		clients: {
			matchAll: () => Promise.resolve([]),
			openWindow: (url: string) => {
				opened = url;
				return Promise.resolve();
			},
		},
	};
	vm.runInNewContext(SOURCE, { self, URL });
	let pending: Promise<unknown> = Promise.resolve();
	listeners.notificationclick({
		notification: { close: () => undefined, data },
		waitUntil: (p: Promise<unknown>) => {
			pending = p;
		},
	});
	await pending;
	return opened;
}

describe("public/sw.js notificationclick", () => {
	it("opens a relative path of the own site", async () => {
		expect(await clickTarget({ url: "/portal/afiliacao" })).toBe(`${ORIGIN}/portal/afiliacao`);
	});

	it.each([
		"//evil.com/x",
		"https://evil.com/x",
		"/\\evil.com",
		"/portal\\..\\x",
		"portal",
		undefined,
		42,
	])("falls back to /portal for %s", async (url) => {
		expect(await clickTarget({ url })).toBe(`${ORIGIN}/portal`);
	});

	it("falls back to /portal without data", async () => {
		expect(await clickTarget(undefined)).toBe(`${ORIGIN}/portal`);
	});
});
