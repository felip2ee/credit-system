// Next 14.2: router.refresh() e o revalidatePath de uma Server Action perdem o `loading` só do segmento raiz. Com
// src/app/loading.tsx, a primeira atualização troca o Suspense por um Fragment e remonta o app inteiro (o aviso de
// "salvo" some e o diálogo fecha). Cada área tem o próprio loading.tsx.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("telas de carregamento", () => {
	it("não tem loading.tsx no segmento raiz", () => {
		expect(existsSync(join(__dirname, "loading.tsx"))).toBe(false);
	});
});
