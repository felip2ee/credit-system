export type ProductCopy = { summary: string; includes: string[] };

const COPY: Record<string, ProductCopy> = {
	dossie_pf: {
		summary: "Tudo o que pesa no seu CPF na hora de pedir crédito, e o plano para destravar.",
		includes: [
			"O raio-x do seu CPF no sistema financeiro: dívidas, atrasos e o histórico que o banco vê no Banco Central (SCR)",
			"Os pontos cegos: o que está travando seu crédito hoje, inclusive o que você não sabia",
			"O seu teto de crédito: até onde o banco tende a ir com você hoje",
			"O plano da Rainha Cred, em ordem: o que resolver primeiro e o que fazer depois",
			"Tudo na tela e em PDF, com aviso por e-mail e WhatsApp quando fica pronto",
		],
	},
	dossie_empresarial: {
		summary: "A empresa e as pessoas por trás dela, analisadas juntas, do jeito que o banco analisa.",
		includes: [
			"O raio-x da empresa no sistema financeiro: dívidas, atrasos e histórico do CNPJ",
			"A análise de cada sócio e dos cônjuges que pesam no crédito. Cada pessoa autoriza a própria consulta",
			"O cruzamento entre empresa e sócios: onde um CPF está travando o CNPJ, e o contrário",
			"O plano da Rainha Cred para o grupo, em ordem: o que resolver primeiro e o que fazer depois",
			"Tudo na tela e em PDF, com aviso por e-mail e WhatsApp quando fica pronto",
		],
	},
};

// Dossiê PF em conta PJ: a pesquisa é de outra pessoa, então o texto não fala em "seu".
const THIRD_PARTY_PF: ProductCopy = {
	summary: "Tudo o que pesa no CPF pesquisado na hora de pedir crédito, e o plano para destravar.",
	includes: [
		"O raio-x do CPF no sistema financeiro: dívidas, atrasos e o histórico que o banco vê no Banco Central (SCR)",
		"Os pontos cegos: o que está travando o crédito hoje, inclusive o que ninguém sabia",
		"O teto de crédito: até onde o banco tende a ir hoje com essa pessoa",
		"O plano da Rainha Cred, em ordem: o que resolver primeiro e o que fazer depois",
		"Tudo na tela e em PDF, com aviso por e-mail e WhatsApp quando fica pronto",
	],
};

// "O que você pode e não pode": as regras reais do pedido, por produto e tipo de conta.
export function productRules(code: string, self: boolean): string[] {
	if (code === "dossie_empresarial") {
		return [
			"Inclui a empresa e os sócios que você adicionar.",
			"Cada sócio custa o valor por sócio.",
			"Quem ainda não tem autorização válida nem um pedido em aberto recebe um pedido por e-mail.",
			"A consulta só roda depois da autorização de todos.",
		];
	}
	return self
		? ["A pesquisa é só do CPF do dono da conta.", "Você não pode pesquisar outra pessoa por aqui."]
		: ["A pesquisa é do CPF que você informar, como o do responsável pela empresa.", "A consulta só roda depois da autorização da pessoa pesquisada."];
}

export function productCopy(code: string, self = true): ProductCopy | null {
	if (code === "dossie_pf" && !self) return THIRD_PARTY_PF;
	return COPY[code] ?? null;
}
