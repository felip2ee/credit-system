import { describe, expect, it } from "vitest";

import { linkPartnerSchema } from "./holder";

const base = { cpf: "390.533.447-05", name: "Maria Souza" };

describe("linkPartnerSchema", () => {
	it("normalizes the CPF and the optional fields", () => {
		const parsed = linkPartnerSchema.safeParse({ ...base, percentage: 33.5, role: " " });
		expect(parsed.success && parsed.data).toEqual({
			document: "39053344705",
			name: "Maria Souza",
			percentage: 33.5,
			role: null,
		});
	});

	it("accepts the limits 0 and 100 and a missing percentage", () => {
		expect(linkPartnerSchema.safeParse({ ...base, percentage: 0 }).success).toBe(true);
		expect(linkPartnerSchema.safeParse({ ...base, percentage: 100 }).success).toBe(true);
		const none = linkPartnerSchema.safeParse(base);
		expect(none.success && none.data.percentage).toBeNull();
	});

	it.each([-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects percentage %j",
		(percentage) => {
			const parsed = linkPartnerSchema.safeParse({ ...base, percentage });
			expect(!parsed.success && parsed.error.issues[0]?.message).toBe(
				"Participação do sócio deve estar entre 0 e 100.",
			);
		},
	);

	it("rejects an invalid CPF and a short name", () => {
		const cpf = linkPartnerSchema.safeParse({ ...base, cpf: "123" });
		expect(!cpf.success && cpf.error.issues[0]?.message).toBe("CPF do sócio inválido.");
		const name = linkPartnerSchema.safeParse({ ...base, name: "Jo" });
		expect(!name.success && name.error.issues[0]?.message).toBe("Informe o nome do sócio.");
	});
});
