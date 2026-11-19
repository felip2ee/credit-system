import { normalizeMoney } from "@/lib/catalog/money-input";
import type { CouponRow } from "@/lib/coupons/queries";
import { COUPON_PRODUCT_CODES, couponCreateSchema, type CouponCreate } from "@/lib/validators/coupons";

export type CouponProductCode = (typeof COUPON_PRODUCT_CODES)[number];

export const PRODUCT_LABELS: Record<CouponProductCode, string> = {
  dossie_pf: "Dossiê Pessoa Física",
  dossie_empresarial: "Dossiê Empresarial Estruturado",
};

// Estado do formulário: tudo texto, como o usuário digita. Data em AAAA-MM-DD.
export interface CouponDraft {
  code: string;
  kind: "percent" | "fixed";
  value: string;
  allProducts: boolean;
  productCodes: CouponProductCode[];
  maxUses: string;
  maxUsesPerClient: string;
  // Verdadeiro quando o usuário mexeu no limite por cliente (ou o cupom já existia): para de sugerir 1.
  perClientTouched: boolean;
  validFrom: string;
  validUntil: string;
}

export type CouponField =
  | "code"
  | "kind"
  | "value"
  | "productCodes"
  | "maxUses"
  | "maxUsesPerClient"
  | "validFrom"
  | "validUntil";
export type CouponErrors = Partial<Record<CouponField, string>>;

export const EMPTY_DRAFT: CouponDraft = {
  code: "",
  kind: "percent",
  value: "",
  allProducts: true,
  productCodes: [],
  maxUses: "",
  maxUsesPerClient: "",
  perClientTouched: false,
  validFrom: "",
  validUntil: "",
};

const SP_OFFSET = "-03:00";

// Data do banco (instante) vista no fuso de São Paulo, para o campo de data.
function toDateInput(value: Date | string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(value));
}

export function draftFromCoupon(coupon: CouponRow): CouponDraft {
  return {
    code: coupon.code,
    kind: coupon.kind,
    value: coupon.value.replace(".", ","),
    allProducts: coupon.allProducts,
    productCodes: coupon.productCodes.filter((c): c is CouponProductCode =>
      (COUPON_PRODUCT_CODES as readonly string[]).includes(c),
    ),
    maxUses: coupon.maxUses === null ? "" : String(coupon.maxUses),
    maxUsesPerClient: coupon.maxUsesPerClient === null ? "" : String(coupon.maxUsesPerClient),
    perClientTouched: true,
    validFrom: toDateInput(coupon.validFrom),
    validUntil: toDateInput(coupon.validUntil),
  };
}

// Escolher "todos os produtos" limpa a escolha; escolher produtos parte da lista vazia.
export function setAllProducts(draft: CouponDraft, allProducts: boolean): CouponDraft {
  return { ...draft, allProducts, productCodes: [] };
}

export function toggleProduct(draft: CouponDraft, code: CouponProductCode): CouponDraft {
  const productCodes = draft.productCodes.includes(code)
    ? draft.productCodes.filter((c) => c !== code)
    : [...draft.productCodes, code];
  return { ...draft, productCodes };
}

// Com limite total e o campo por cliente intocado, sugere 1 (o mesmo padrão do schema); sem limite total, volta a vazio.
export function setMaxUses(draft: CouponDraft, maxUses: string): CouponDraft {
  if (draft.perClientTouched) return { ...draft, maxUses };
  return { ...draft, maxUses, maxUsesPerClient: maxUses.trim() === "" ? "" : "1" };
}

export function setMaxUsesPerClient(draft: CouponDraft, maxUsesPerClient: string): CouponDraft {
  return { ...draft, maxUsesPerClient, perClientTouched: true };
}

// Campo vazio = ilimitado (null). Texto não numérico vira NaN e o schema recusa.
function limitOrNull(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

// Início vale desde 00:00 e fim até 23:59:59, no horário de São Paulo.
function dateBoundary(day: string, time: string): string | null {
  return day === "" ? null : `${day}T${time}${SP_OFFSET}`;
}

export function toCouponInput(draft: CouponDraft): unknown {
  return {
    code: draft.code,
    kind: draft.kind,
    value: normalizeMoney(draft.value),
    allProducts: draft.allProducts,
    productCodes: draft.allProducts ? [] : draft.productCodes,
    maxUses: limitOrNull(draft.maxUses),
    maxUsesPerClient: limitOrNull(draft.maxUsesPerClient),
    validFrom: dateBoundary(draft.validFrom, "00:00:00"),
    validUntil: dateBoundary(draft.validUntil, "23:59:59"),
  };
}

export type CouponValidation = { ok: true; values: CouponCreate } | { ok: false; errors: CouponErrors };

// Mesmo schema da action: a mensagem do campo é a que o servidor devolveria.
export function validateDraft(draft: CouponDraft): CouponValidation {
  const parsed = couponCreateSchema.safeParse(toCouponInput(draft));
  if (parsed.success) return { ok: true, values: parsed.data };
  const errors: CouponErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as CouponField | undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}

export function limitLabel(limit: number | null): string {
  return limit === null ? "Ilimitado" : String(limit);
}
