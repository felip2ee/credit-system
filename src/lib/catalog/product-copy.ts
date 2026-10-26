export type ProductCopy = { summary: string; includes: string[] };

const COPY: Record<string, ProductCopy> = {
	dossie_pf: {
		summary: "Dívidas e histórico no sistema financeiro do seu CPF. Relatório em tela e em PDF.",
		includes: [
			"Dívidas e histórico no sistema financeiro (dados do Banco Central, SCR)",
			"Parecer pela metodologia da Rainha Cred, gerado com apoio de IA, com pontos de atenção e próximos passos",
			"Relatório na tela e em PDF",
			"Aviso por e-mail e WhatsApp quando o relatório fica pronto",
		],
	},
	dossie_empresarial: {
		summary: "Dívidas e histórico da sua empresa (CNPJ) e dos sócios. Relatório em tela e em PDF.",
		includes: [
			"Dívidas e histórico da empresa no sistema financeiro",
			"Consulta de cada sócio informado, com autorização",
			"Parecer pela metodologia da Rainha Cred, gerado com apoio de IA, com pontos de atenção e próximos passos",
			"Relatório na tela e em PDF",
			"Aviso por e-mail e WhatsApp quando o relatório fica pronto",
		],
	},
};

export function productCopy(code: string): ProductCopy | null {
	return COPY[code] ?? null;
}
