// Checklist de Financiamento Imobiliário — gerado por cenário.
// Fonte: lista oficial do banco parceiro (análise de crédito + imóvel + vendedor).
// As condicionais (perfil do comprador, imóvel novo/usado, vendedor PF/PJ e
// cônjuge) montam só os documentos aplicáveis, mantendo a % de conclusão correta.

import type { DocSlot } from "@/types/app";

// Nome exato do produto em credit_products (migration 010).
export const REAL_ESTATE_PRODUCT_NAME = "Financiamento Imobiliário";

export type BuyerProfile = "clt" | "simples" | "mei";
export type PropertyKind = "novo" | "usado";
export type SellerKind = "pf" | "pj";

export interface FinancingScenario {
  buyer: BuyerProfile;
  property: PropertyKind;
  seller: SellerKind;
  married: boolean;
}

export const DEFAULT_FINANCING_SCENARIO: FinancingScenario = {
  buyer: "clt",
  property: "usado",
  seller: "pf",
  married: false,
};

export const BUYER_LABEL: Record<BuyerProfile, string> = {
  clt: "Assalariado (CLT)",
  simples: "Empresário (Simples Nacional)",
  mei: "MEI",
};
export const PROPERTY_LABEL: Record<PropertyKind, string> = {
  novo: "Imóvel novo",
  usado: "Imóvel usado",
};
export const SELLER_LABEL: Record<SellerKind, string> = {
  pf: "Vendedor pessoa física",
  pj: "Vendedor pessoa jurídica",
};

// Lê o cenário salvo em opportunities.pf_extra_data (ou retorna o default).
export function readScenario(
  pfExtraData: Record<string, unknown> | null
): FinancingScenario {
  const raw = (pfExtraData?.["financing_scenario"] ?? null) as
    | Partial<FinancingScenario>
    | null;
  if (!raw) return DEFAULT_FINANCING_SCENARIO;
  const buyer: BuyerProfile =
    raw.buyer === "simples" || raw.buyer === "mei" ? raw.buyer : "clt";
  const property: PropertyKind = raw.property === "novo" ? "novo" : "usado";
  const seller: SellerKind = raw.seller === "pj" ? "pj" : "pf";
  return { buyer, property, seller, married: Boolean(raw.married) };
}

// Monta os slots do checklist conforme o cenário.
export function realEstateSlots(s: FinancingScenario): DocSlot[] {
  const slots: DocSlot[] = [];

  // ── Comprador — análise de crédito (base) ──
  slots.push(
    { doc_type: "re_buyer_id", label: "Comprador — Documento oficial (RG ou CNH)" },
    { doc_type: "re_buyer_cpf", label: "Comprador — CPF" },
    {
      doc_type: "re_buyer_marital",
      label:
        "Comprador — Comprovante de estado civil (nascimento/casamento/divórcio)",
    },
    {
      doc_type: "re_buyer_address",
      label: "Comprador — Comprovante de endereço atualizado",
    }
  );

  // ── Renda — conforme o vínculo do comprador ──
  if (s.buyer === "clt") {
    slots.push(
      { doc_type: "re_clt_payslips", label: "Renda CLT — 3 últimos contracheques" },
      {
        doc_type: "re_clt_ctps",
        label: "Renda CLT — Carteira de trabalho digital atualizada",
      },
      { doc_type: "re_clt_fgts", label: "Renda CLT — Extrato do FGTS atualizado" },
      {
        doc_type: "re_buyer_irpf",
        label: "Comprador — Declaração de IR + recibo (se declarou)",
      }
    );
  } else if (s.buyer === "simples") {
    slots.push(
      {
        doc_type: "re_buyer_irpf",
        label: "Comprador — Declaração de IR + recibo de entrega",
      },
      {
        doc_type: "re_sn_social_contract",
        label:
          "Empresa (Simples) — Contrato social (última alteração ou consolidado)",
      },
      { doc_type: "re_sn_defis", label: "Empresa (Simples) — DEFIS do último ano" },
      {
        doc_type: "re_sn_pgdas",
        label: "Empresa (Simples) — PGDAS/extrato do Simples do último mês",
      },
      {
        doc_type: "re_sn_bank_6m",
        label: "Empresa (Simples) — Extrato bancário 6 meses (PF e PJ)",
      }
    );
  } else {
    // mei
    slots.push(
      {
        doc_type: "re_mei_ctps",
        label: "Renda MEI — Carteira de trabalho digital completa e atualizada",
      },
      {
        doc_type: "re_buyer_irpf",
        label: "Comprador — Declaração de IR + recibo (PF)",
      },
      {
        doc_type: "re_mei_ccmei",
        label: "MEI — Certificado do Microempreendedor (CCMEI)",
      },
      {
        doc_type: "re_mei_dasn",
        label: "MEI — DASN-SIMEI (declaração anual de faturamento)",
      },
      {
        doc_type: "re_mei_bank_6m",
        label: "MEI — Extrato bancário 6 meses (PF e PJ)",
      }
    );
  }

  // ── Cônjuge (se casado) ──
  if (s.married) {
    slots.push(
      { doc_type: "re_spouse_id_cpf", label: "Cônjuge — Identidade (RG/CNH) e CPF" },
      {
        doc_type: "re_spouse_marital",
        label: "Cônjuge — Comprovante de estado civil",
      },
      { doc_type: "re_spouse_address", label: "Cônjuge — Comprovante de endereço" }
    );
  }

  // ── Imóvel ──
  if (s.property === "novo") {
    slots.push(
      {
        doc_type: "re_prop_matricula",
        label: "Imóvel novo — Certidão de matrícula (inteiro teor) atualizada",
      },
      { doc_type: "re_prop_art", label: "Imóvel novo — ART (Projeto e Execução)" },
      { doc_type: "re_prop_alvara", label: "Imóvel novo — Alvará de construção" },
      { doc_type: "re_prop_habitese", label: "Imóvel novo — Habite-se" },
      {
        doc_type: "re_prop_scpo",
        label: "Imóvel novo — SCPO (Comunicação Prévia de Obras)",
      },
      {
        doc_type: "re_prop_decl_exec",
        label: "Imóvel novo — Declaração de execução de elementos construtivos",
      },
      {
        doc_type: "re_prop_crea_cau",
        label: "Imóvel novo — CREA/CAU do responsável técnico",
      }
    );
  } else {
    slots.push({
      doc_type: "re_prop_matricula",
      label:
        "Imóvel usado — Certidão de matrícula inteiro teor atualizada (Registro de Imóveis)",
    });
  }

  // ── Vendedor ──
  if (s.seller === "pf") {
    slots.push(
      { doc_type: "re_seller_id", label: "Vendedor PF — Identidade e CPF ou CNH" },
      {
        doc_type: "re_seller_marital",
        label: "Vendedor PF — Comprovante de estado civil",
      },
      {
        doc_type: "re_seller_address",
        label: "Vendedor PF — Comprovante de endereço atualizado",
      },
      {
        doc_type: "re_seller_bank",
        label: "Vendedor PF — Dados bancários (preferencialmente Caixa)",
      }
    );
  } else {
    slots.push(
      {
        doc_type: "re_seller_social_contract",
        label: "Vendedor PJ — Contrato social e alterações (ou consolidado)",
      },
      {
        doc_type: "re_seller_junta",
        label: "Vendedor PJ — Certidão Simplificada da Junta (≤ 180 dias)",
      },
      {
        doc_type: "re_seller_admin_id",
        label:
          "Vendedor PJ — Identidade e CPF/CNH do(s) sócio(s) administrador(es)",
      },
      {
        doc_type: "re_seller_bank",
        label: "Vendedor PJ — Dados bancários PJ (preferencialmente Caixa)",
      }
    );
  }

  return slots;
}
