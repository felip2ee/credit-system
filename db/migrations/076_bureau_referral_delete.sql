-- Indicação entre bureaus: o superadmin remove o indicador (RLS bureau_referrals_superadmin_write cobre o delete).
-- Apagar a linha, e não desativar, mantém o gatilho de ciclo (070), que não olha `active`, sem linhas mortas.
grant delete on bureau_referrals to app_runtime;
