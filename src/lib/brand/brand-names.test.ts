import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");
const OLD_NAMES = /Reino do Crédito|Rainha do Crédito|Beabá do Crédito|Eliane Moreira/;
// Razão social do termo SCR é texto legal; PDF e rotas de PDF são cobertos na Tarefa 6.
const ALLOWED = ["lib/scr/consent-term.ts"];
const SKIPPED_DIRS = ["lib/pdf"];

function listFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? listFiles(full) : [full];
	});
}

function isScanned(rel: string): boolean {
	if (!/\.(ts|tsx|md)$/.test(rel)) return false;
	if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) return false;
	if (ALLOWED.includes(rel)) return false;
	if (SKIPPED_DIRS.some((d) => rel.startsWith(`${d}/`))) return false;
	return !/(^|\/)pdf\/route\.ts$/.test(rel);
}

describe("brand name", () => {
	it("keeps only Rainha Cred in src", () => {
		const offenders = listFiles(SRC)
			.map((f) => path.relative(SRC, f).split(path.sep).join("/"))
			.filter(isScanned)
			.filter((rel) => OLD_NAMES.test(readFileSync(path.join(SRC, rel), "utf8")));
		expect(offenders).toEqual([]);
	});
});
