// Rótulos em português para a tela de Auditoria. Só exibição: o código bruto continua
// gravado em audit_logs.action e aparece como linha secundária (busca do suporte).

import { SENSITIVE_KEY } from "@/lib/audit/write";

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  "bureau.consult": "Consulta ao bureau",
  "bureau.create": "Bureau criado",
  "bureau.update": "Bureau alterado",
  "bureau.activate": "Bureau ativado",
  "bureau.deactivate": "Bureau desativado",
  "superadmin.bootstrap": "Primeiro administrador criado",
  "user.invite": "Convite enviado a usuário",
  "user.create_with_password": "Usuário criado com senha",
  "user.role_change": "Perfil do usuário alterado",
  "user.activate": "Usuário ativado",
  "user.deactivate": "Usuário desativado",
  "user.password_changed": "Senha alterada pelo usuário",
  "user.password_set": "Senha definida por administrador",
  "user.force_password_change": "Troca de senha exigida",
  "portal.invite": "Acesso ao portal enviado ao titular",
  "portal.reinvite": "Acesso ao portal reenviado ao titular",
  "portal.revoke": "Acesso ao portal removido do titular",
  "holder.create": "Titular cadastrado",
  "holder.update": "Titular alterado",
  "holder.partner_link": "Sócio vinculado ao titular",
  "holder.note_add": "Observação adicionada ao titular",
  "dossier.report": "Relatório do dossiê gerado",
  "consultation.status": "Status da consulta alterado",
  "ai.opinion": "Parecer de IA gerado",
  "scr.expire": "Autorização SCR expirada",
  "order.open": "Pedido aberto",
  "order.complete": "Pedido concluído",
  "order.fail": "Pedido com falha",
  "order.cancel": "Pedido cancelado",
  "order.release": "Pedido liberado ao cliente",
  "order.revoke": "Liberação do pedido revogada",
  "order.retry": "Pedido reprocessado",
  "order.declaration_accepted": "Declaração do pedido aceita",
  "order.ai_status": "Parecer de IA do pedido atualizado",
  "notification.enqueue": "Notificação colocada na fila",
  "notification.retry": "Envio de notificação repetido",
  "nfse.retry": "Emissão de nota fiscal repetida",
  "lgpd.anonymize_holder": "Titular anonimizado (LGPD)",
  "lgpd.anonymize_client_account": "Conta de cliente anonimizada (LGPD)",
  "lgpd.purge_bureau": "Dados do bureau apagados (LGPD)",
  "lgpd.export_holder": "Dados do titular exportados (LGPD)",
  "settlement.reserve": "Saldo reservado para pedido",
  "settlement.capture": "Saldo cobrado do pedido",
  "settlement.release": "Reserva de saldo devolvida",
  "support.start": "Sessão de suporte iniciada",
  "support.end": "Sessão de suporte encerrada",
  "catalog.product.create": "Produto criado no catálogo",
  "catalog.product.update": "Produto alterado no catálogo",
  "catalog.product.version": "Nova versão de produto",
  "catalog.cost.set": "Custo do produto definido",
  "catalog.item.upsert": "Item do catálogo salvo",
  "counter.register": "Pagamento no balcão registrado",
  "counter.void": "Pagamento no balcão anulado",
  "wallet.topup": "Recarga de saldo confirmada",
  "wallet.topup.request": "Recarga de saldo solicitada",
  "wallet.reversal": "Recarga de saldo estornada",
  "wallet.adjust": "Saldo ajustado manualmente",
  "client_wallet.adjust": "Saldo do cliente ajustado manualmente",
  "client.register": "Cliente cadastrado",
  "client.email_verification_requested": "Verificação de e-mail solicitada",
  "client.email_verified": "E-mail do cliente verificado",
  "client.phone_verification_requested": "Verificação de celular solicitada",
  "client.phone_verified": "Celular do cliente verificado",
  "client.legal_accepted": "Termos aceitos pelo cliente",
  "client.notification_channel_set": "Canal de aviso do cliente definido",
  "affiliate.rate": "Taxa de afiliado alterada",
  "affiliate.referral_linked": "Cliente vinculado a afiliado",
  "affiliate.commission": "Comissão de afiliado gerada",
  "affiliate.commission_release": "Comissão de afiliado liberada",
  "affiliate.commission_reversal": "Comissão de afiliado estornada",
  "affiliate.conversion": "Comissão convertida em saldo",
  "affiliate.forfeit": "Comissão perdida",
  "withdrawal.request": "Saque solicitado",
  "withdrawal.view": "Dados do saque consultados",
  "withdrawal.paid": "Saque pago",
  "withdrawal.cancel": "Saque cancelado",
  "payout.create": "Repasse criado",
  "payout.pay": "Repasse pago",
  "payout.cancel": "Repasse cancelado",
  "settings.update": "Configuração alterada",
  "settings.delete": "Configuração removida",
  "settings.reset": "Configuração restaurada ao padrão",
  "settings.prompts_update": "Prompts de IA alterados",
  "settings.prompts_reset": "Prompts de IA restaurados ao padrão",
  "settings.scr_update": "Configuração do SCR alterada",
  "settings.affiliates": "Configuração de afiliados alterada",
  "settings.payable_retention": "Prazo de retenção dos repasses alterado",
  "coupon.create": "Cupom criado",
  "coupon.update": "Cupom alterado",
  "coupon.activate": "Cupom reativado",
  "coupon.deactivate": "Cupom desativado",
  "coupon.redeem": "Cupom usado em pedido",
  "coupon.release": "Uso do cupom devolvido",
};

export interface AuditActionLabel {
  label: string;
  raw: string;
  known: boolean;
}

export function auditActionLabel(code: string): AuditActionLabel {
  const label = AUDIT_ACTION_LABEL[code];
  return { label: label ?? code, raw: code, known: label !== undefined };
}

const KEY_LABEL: Record<string, string> = {
  role: "Perfil",
  email: "E-mail",
  status: "Situação",
  attempts: "Tentativas",
  keys: "Itens",
  from: "Antes",
  to: "Depois",
  model: "Modelo",
  promptVersion: "Versão do prompt",
  user_id: "Usuário",
  new_cost: "Novo custo",
  old_cost: "Custo anterior",
  amount: "Valor",
  reason: "Motivo",
};

export function auditKeyLabel(key: string): string {
  return KEY_LABEL[key] ?? key;
}

const MAX_VALUE = 60;

// Pares "Rótulo: valor" legíveis. Ignora chaves sensíveis (documento já tem coluna própria) e objetos.
export function describeAuditMetadata(
  data: Record<string, unknown> | null,
): string[] {
  if (!data) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY.test(key) || value === null || value === undefined)
      continue;
    const text = Array.isArray(value)
      ? value.filter((v) => typeof v !== "object").join(", ")
      : typeof value === "object"
        ? ""
        : String(value);
    if (!text) continue;
    const short =
      text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
    out.push(`${auditKeyLabel(key)}: ${short}`);
  }
  return out;
}
