import type { PayerField } from "@/lib/payers/queries";
import { cardFieldsSchema, payerFieldsSchema } from "@/lib/validators/payer";
import type { CheckoutInput } from "@/lib/validators/checkout";
import { parseTopupInput } from "@/lib/wallet/topup-input";

// Lógica pura do checkout (sem DOM): validação, montagem do envio e formatação.
// Nenhuma mensagem de erro leva o valor digitado (documento, número do cartão, CVV).

export type PayerKind = "owner" | "other";
export type Method = "PIX" | "CREDIT_CARD";

export const PAYER_FIELDS: PayerField[] = ["name", "document", "email", "phone", "postalCode", "addressNumber"];

export type CardDraft = { number: string; holderName: string; expiry: string; cvv: string };
export const EMPTY_CARD: CardDraft = { number: "", holderName: "", expiry: "", cvv: "" };

export type CheckoutErrors = Partial<Record<"amount" | "declaration" | "installments" | PayerField | keyof CardDraft, string>>;

const REQUIRED: Record<PayerField | keyof CardDraft | "declaration", string> = {
  name: "Informe o nome.",
  document: "Informe o CPF ou CNPJ.",
  email: "Informe o e-mail.",
  phone: "Informe o celular com DDD.",
  postalCode: "Informe o CEP.",
  addressNumber: "Informe o número.",
  number: "Informe o número do cartão.",
  holderName: "Informe o nome impresso no cartão.",
  expiry: "Informe a validade (MM/AA).",
  cvv: "Informe o código de segurança.",
  declaration: "Confirme que você tem autorização para usar estes dados.",
};

/** Celular brasileiro digitado ("(11) 91234-5678") para E.164. Já com "+" ou com 55 + DDD, mantém. */
export function toE164(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits === "") return "";
  if (value.trim().startsWith("+")) return `+${digits}`;
  return digits.length >= 12 && digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
}

/** Digitação "1230" vira "12/30". Aceita só dígitos e barra. */
export function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

/** "MM/AA" para mês e ano de 4 dígitos, ou null. */
export function parseExpiry(value: string): { expiryMonth: string; expiryYear: string } | null {
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec(value.trim());
  return match ? { expiryMonth: match[1], expiryYear: `20${match[2]}` } : null;
}

function fieldValue(field: PayerField, raw: string): string {
  return field === "phone" ? toE164(raw) : raw.trim();
}

/** Campos que o envio leva: "outros" manda os seis; dono manda os que faltam mais os alterados. O e-mail do dono é ignorado. */
export function payerFieldsToSend(kind: PayerKind, missing: PayerField[], editing: ReadonlySet<PayerField>): PayerField[] {
  if (kind === "other") return PAYER_FIELDS;
  return PAYER_FIELDS.filter((f) => f !== "email" && (missing.includes(f) || editing.has(f)));
}

export type BuildInput = {
  amount: string;
  method: Method;
  kind: PayerKind;
  installments: number;
  missing: PayerField[];
  editing: ReadonlySet<PayerField>;
  values: Record<PayerField, string>;
  card: CardDraft;
  declaration: boolean;
  idempotencyKey: string;
};

export type BuildResult = { ok: true; input: CheckoutInput } | { ok: false; errors: CheckoutErrors };

export function buildCheckoutInput(s: BuildInput): BuildResult {
  const errors: CheckoutErrors = {};

  const amount = parseTopupInput(s.amount);
  if (!amount.ok) errors.amount = amount.error;

  const payer: Record<string, string> = {};
  for (const field of payerFieldsToSend(s.kind, s.missing, s.editing)) {
    const value = fieldValue(field, s.values[field]);
    if (value === "") {
      errors[field] = REQUIRED[field];
      continue;
    }
    const parsed = payerFieldsSchema.shape[field].safeParse(value);
    if (!parsed.success) errors[field] = parsed.error.issues[0].message;
    else payer[field] = String(parsed.data);
  }

  if (s.kind === "other" && !s.declaration) errors.declaration = REQUIRED.declaration;

  let card: CheckoutInput["card"];
  if (s.method === "CREDIT_CARD") {
    const expiry = parseExpiry(s.card.expiry);
    if (s.card.expiry.trim() === "") errors.expiry = REQUIRED.expiry;
    else if (!expiry) errors.expiry = "Validade inválida. Use MM/AA.";
    for (const key of ["number", "holderName", "cvv"] as const) {
      if (s.card[key].trim() === "") errors[key] = REQUIRED[key];
    }
    if (!Object.keys(errors).some((k) => k === "number" || k === "holderName" || k === "cvv" || k === "expiry")) {
      const parsed = cardFieldsSchema.safeParse({
        number: s.card.number,
        holderName: s.card.holderName,
        cvv: s.card.cvv,
        ...expiry,
      });
      if (parsed.success) card = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          const key = issue.path[0];
          const target = key === "expiryMonth" || key === "expiryYear" ? "expiry" : (key as keyof CardDraft);
          errors[target] ??= issue.message;
        }
      }
    }
  }

  if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };

  return {
    ok: true,
    input: {
      amount: amount.amount,
      method: s.method,
      payerKind: s.kind,
      idempotencyKey: s.idempotencyKey,
      ...(s.method === "CREDIT_CARD" ? { installments: s.installments, card } : {}),
      ...(Object.keys(payer).length > 0 ? { payer } : {}),
      ...(s.kind === "other" ? { declaration: true as const } : {}),
    },
  };
}
