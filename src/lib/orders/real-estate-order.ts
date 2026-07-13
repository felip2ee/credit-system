// Dados iniciais de um pedido PF de Financiamento Imobiliário (espelha o que os
// parceiros/bancos pedem para abrir a análise). Persistido em
// opportunities.pf_extra_data.financing_data. São dados de pedido (não entram em
// cálculo), então ficam como texto — simples de editar e exibir.

export const OCCUPATIONS = [
  "Assalariado",
  "Aposentado",
  "Autônomo",
  "Empresário",
  "Estagiário",
  "Funcionário Público",
  "Profissional Liberal",
] as const;

export const MARITAL_STATUSES = [
  "Solteiro(a)",
  "Casado(a)",
  "Divorciado(a)",
  "Viúvo(a)",
  "Separado(a)",
] as const;

export const PROPERTY_TYPES = [
  "Apartamento padrão",
  "Casa padrão",
  "Terreno",
  "Casa em Condomínio",
  "Casa modular",
  "Sala Comercial",
  "Galpão",
  "Terreno Condomínio",
  "Rural",
] as const;

export const PREFERRED_BANKS = [
  "Caixa",
  "Inter",
  "Bradesco",
  "Santander",
  "Itaú",
  "Creditas",
  "Outro",
] as const;

export const YES_NO = ["Sim", "Não"] as const;

export interface RealEstateOrder {
  // ── Proponente ──
  rg: string;
  profession: string;
  monthly_income: string;
  occupation: string;
  employer: string;
  marital_status: string;
  compose_income: string; // Vai compor renda? (Sim/Não)
  // Cônjuge / segundo proponente
  spouse_name: string;
  spouse_cpf: string;
  spouse_birth_date: string;
  // ── Imóvel / financiamento ──
  preferred_bank: string;
  property_type: string;
  property_value: string;
  desired_value: string;
  down_payment: string; // valor de entrada
  term_months: string; // prazo (meses)
  use_fgts: string; // Sim/Não
  finance_itbi: string; // financiar ITBI e cartório? (Sim/Não)
  has_iq: string; // possui IQ — imóvel já financiado (Sim/Não)
  property_location: string; // CEP e número do imóvel a financiar
  additional_info: string; // informações adicionais sobre o imóvel
  objective: string; // o que deseja fazer
}

export const REAL_ESTATE_ORDER_KEYS: (keyof RealEstateOrder)[] = [
  "rg",
  "profession",
  "monthly_income",
  "occupation",
  "employer",
  "marital_status",
  "compose_income",
  "spouse_name",
  "spouse_cpf",
  "spouse_birth_date",
  "preferred_bank",
  "property_type",
  "property_value",
  "desired_value",
  "down_payment",
  "term_months",
  "use_fgts",
  "finance_itbi",
  "has_iq",
  "property_location",
  "additional_info",
  "objective",
];

export const EMPTY_REAL_ESTATE_ORDER: RealEstateOrder =
  REAL_ESTATE_ORDER_KEYS.reduce((acc, k) => {
    acc[k] = "";
    return acc;
  }, {} as RealEstateOrder);

// Lê e normaliza o pedido salvo em pf_extra_data.financing_data.
export function readRealEstateOrder(
  pfExtraData: Record<string, unknown> | null
): RealEstateOrder {
  const raw = (pfExtraData?.["financing_data"] ?? {}) as Record<string, unknown>;
  const out = { ...EMPTY_REAL_ESTATE_ORDER };
  for (const k of REAL_ESTATE_ORDER_KEYS) {
    const v = raw[k];
    out[k] = typeof v === "string" ? v : v == null ? "" : String(v);
  }
  return out;
}
