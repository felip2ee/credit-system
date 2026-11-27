-- Painel de repasses e prejuízo por cliente (plano afiliado-bureaus, parte 1, task 7).
-- O prejuízo por cliente soma o saldo negativo que o estorno deixou na carteira do afiliado (livro-razão, kind
-- 'commission_clawback'). O bureau_admin já lê a carteira (066) e as comissões (026) dos afiliados do próprio Bureau;
-- agora lê também o livro-razão deles, só leitura. A equipe (operator) e o próprio afiliado seguem como antes (026).
create policy affiliate_ledger_entries_select_admin on affiliate_ledger_entries for select using (
  app_context_present() and app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id()
);
