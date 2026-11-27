-- Configurar pagamentos do afiliado (plano afiliado-bureaus, parte 2, task 2).
-- app_runtime só lia affiliate_wallets. Agora grava só payout_method e asaas_wallet_id (nunca o saldo), e a RLS decide quem:
-- o próprio afiliado, o bureau_admin do bureau dele ou o superadmin fora de suporte. O bureau_admin e o superadmin também
-- leem a linha (modo e walletId, para o cadastro em nome do afiliado).
grant update (payout_method, asaas_wallet_id) on affiliate_wallets to app_runtime;

create policy affiliate_wallets_select_admin on affiliate_wallets for select using (
  app_context_present() and (
    (app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
    or (app_user_role() = 'superadmin' and app_support_session_id() is null))
);

create policy affiliate_wallets_payout_update on affiliate_wallets for update
  using (
    app_context_present() and (
      (app_user_role() = 'client' and bureau_id = app_bureau_id() and profile_id = app_user_id())
      or (app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
      or (app_user_role() = 'superadmin' and app_support_session_id() is null))
  )
  with check (
    app_context_present() and (
      (app_user_role() = 'client' and bureau_id = app_bureau_id() and profile_id = app_user_id())
      or (app_user_role() = 'bureau_admin' and bureau_id = app_bureau_id())
      or (app_user_role() = 'superadmin' and app_support_session_id() is null))
  );
