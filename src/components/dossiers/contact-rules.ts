// Regras de contato do pedido, sem React para testar em Node.
const onlyDigits = (value: string) => value.replace(/\D/g, "");

// Pesquisa própria: o documento consultado é o do Titular escolhido como comprador.
export function isOwnResearch(subjectDocument: string, buyerDocument: string | null | undefined): boolean {
  const subject = onlyDigits(subjectDocument);
  return subject !== "" && buyerDocument != null && subject === onlyDigits(buyerDocument);
}

// Terceiro precisa de e-mail; na pesquisa própria o servidor usa a conta do cliente.
export function missingThirdPartyEmail(ownResearch: boolean, email: string | undefined): boolean {
  return !ownResearch && (email ?? "").trim() === "";
}

export interface ContactUpdateInput {
  dossierId: string;
  consultationId: string;
  contactEmail: string;
  contactPhone: string;
}

// Campos em branco = manter o atual; os dois em branco = só reenviar.
export function buildContactUpdate(dossierId: string, consultationId: string, email: string, phone: string): ContactUpdateInput {
  return { dossierId, consultationId, contactEmail: email.trim(), contactPhone: phone.trim() };
}
