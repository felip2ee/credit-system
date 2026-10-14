import { describe, expect, it } from "vitest";

import { createDossierSchema } from "./dossier";

const CPF = "390.533.447-05";
const CPF_2 = "529.982.247-25";
const CNPJ = "11.222.333/0001-81";

const firstMessage = (input: unknown): string | undefined => {
	const parsed = createDossierSchema.safeParse(input);
	return parsed.success ? undefined : parsed.error.issues[0]?.message;
};

describe("createDossierSchema", () => {
	it("normalizes the documents to digits and defaults the SCR mode", () => {
		const parsed = createDossierSchema.safeParse({
			kind: "PJ_FULL",
			document: CNPJ,
			partners: [{ cpf: CPF, percentage: 50 }],
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.document).toBe("11222333000181");
		expect(parsed.data.partners[0]).toMatchObject({ cpf: "39053344705", percentage: 50 });
		expect(parsed.data.scrMode).toBe("internal");
	});

	it("rejects an unknown kind", () => {
		expect(firstMessage({ kind: "XX", document: CPF })).toBe("Tipo de Dossiê inválido.");
	});

	it("rejects a CPF when the kind is PJ and a CNPJ when it is PF", () => {
		expect(firstMessage({ kind: "PJ", document: CPF })).toBe("Documento inválido.");
		expect(firstMessage({ kind: "PF", document: CNPJ })).toBe("Documento inválido.");
	});

	it("drops blank partners and rejects an invalid partner CPF", () => {
		const blank = createDossierSchema.safeParse({
			kind: "PJ_FULL",
			document: CNPJ,
			partners: [{ cpf: "" }, { cpf: CPF_2 }],
		});
		expect(blank.success && blank.data.partners).toHaveLength(1);
		expect(
			firstMessage({ kind: "PJ_FULL", document: CNPJ, partners: [{ cpf: "123" }] }),
		).toBe("CPF de sócio inválido.");
	});

	it.each([-1, 100.01, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects partner percentage %j",
		(percentage) => {
			expect(
				firstMessage({ kind: "PJ_FULL", document: CNPJ, partners: [{ cpf: CPF, percentage }] }),
			).toBe("Participação do sócio deve estar entre 0 e 100.");
		},
	);

	it("ignores partners for a kind other than PJ_FULL", () => {
		const parsed = createDossierSchema.safeParse({
			kind: "PJ",
			document: CNPJ,
			partners: [{ cpf: "123" }],
		});
		expect(parsed.success && parsed.data.partners).toEqual([]);
	});

	it("rejects an invalid SCR mode and an invalid e-mail", () => {
		expect(firstMessage({ kind: "PF", document: CPF, scrMode: "x" })).toBe("Modo SCR inválido.");
		expect(firstMessage({ kind: "PF", document: CPF, email: "x" })).toBe("E-mail inválido.");
	});
});
