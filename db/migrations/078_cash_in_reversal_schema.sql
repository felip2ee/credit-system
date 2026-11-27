-- Estorno e chargeback da comissão sobre a entrada (plano afiliado-bureaus, parte 1, task 6): esquema.
-- As funções vêm na 079.
-- 1) Saldo do afiliado pode ficar negativo (decisão D5): estorno de comissão cash_in já liberada tira do disponível, e o
--    que faltar é abatido das próximas comissões. Sai o check available >= 0 da carteira e do livro-razão (026). O
--    pendente continua >= 0. Quem impede saque e conversão com saldo <= 0 é affiliate_wallet_post_entry (079): só o novo
--    kind 'commission_clawback' pode deixar o disponível abaixo de zero.
-- 2) Livro do afiliado: kind novo 'commission_clawback' (estorno de comissão já liberada; tira do disponível).
-- 3) bureau_payable_entries: reverses_entry_id liga o estorno ao accrual que ele desfaz (um por accrual); o estorno do
--    clawback antigo (uma linha por cobrança, sem reverses_entry_id) segue com a trava da 019. adjustment_reason marca o
--    lançamento de ajuste do script zero-legacy-bureau-payables: é um 'reversal' (os leitores de saldo e repasse já
--    somam esse kind), sem cobrança nem pedido.
-- 4) Comissão já liberada pode ser estornada (a política da 027 só deixava atualizar a pendente).
-- 5) Auditoria: payable.cash_in_reversal e charge_split.reversal_failed.

alter table affiliate_wallets drop constraint affiliate_wallets_available_check;
alter table affiliate_ledger_entries drop constraint affiliate_ledger_entries_available_after_check;

alter table affiliate_ledger_entries drop constraint affiliate_ledger_entries_kind_check;
alter table affiliate_ledger_entries add constraint affiliate_ledger_entries_kind_check check (kind in (
  'commission', 'commission_release', 'commission_reversal', 'commission_clawback', 'conversion',
  'withdrawal_hold', 'withdrawal_paid', 'withdrawal_release'));

alter table bureau_payable_entries
  add column reverses_entry_id uuid references bureau_payable_entries(id),
  add column adjustment_reason text;
alter table bureau_payable_entries add constraint bureau_payable_entries_reverses_kind
  check (reverses_entry_id is null or kind = 'reversal');
alter table bureau_payable_entries add constraint bureau_payable_entries_adjustment_kind
  check (adjustment_reason is null or (kind = 'reversal' and btrim(adjustment_reason) <> '' and length(adjustment_reason) <= 500));
create unique index bureau_payable_entries_reverses_idx on bureau_payable_entries(reverses_entry_id)
  where reverses_entry_id is not null;
drop index bureau_payable_entries_reversal_charge_idx;
create unique index bureau_payable_entries_reversal_charge_idx on bureau_payable_entries(pix_charge_id)
  where kind = 'reversal' and reverses_entry_id is null;

create policy affiliate_commissions_gateway_update_released on affiliate_commissions for update to auth_profile_lookup
  using (status = 'released') with check (status in ('released', 'reversed'));

create policy audit_logs_cash_in_reversal_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'payable.cash_in_reversal'
  and support_session_id is null
  and table_name = 'bureau_payable_entries'
  and bureau_id is not null
  and exists (
    select 1 from bureau_payable_entries e where e.id = audit_logs.record_id and e.bureau_id = audit_logs.bureau_id)
);

-- Divergência: o Asaas não reverteu o repasse do split. Mesma forma da política da 072.
create policy audit_logs_charge_split_reversal_failed_insert on audit_logs for insert to auth_profile_lookup with check (
  action = 'charge_split.reversal_failed'
  and support_session_id is null
  and user_id is null
  and table_name = 'charge_splits'
  and exists (
    select 1 from charge_splits s
     where s.id = audit_logs.record_id
       and s.status = 'reversal_failed'
       and ((s.beneficiary_kind = 'partner' and audit_logs.bureau_id is null)
         or (s.beneficiary_kind <> 'partner' and audit_logs.bureau_id = s.bureau_id))
  )
);
