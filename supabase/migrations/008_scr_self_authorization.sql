-- ============================================================
-- 008 — Autogestão de autorização SCR (canal interno "Reino")
-- Permite ao escritório enviar o próprio termo de consentimento SCR por e-mail,
-- com código de confirmação digitado pelo titular numa página pública nossa.
-- Autorização interna vale 365 dias. Aditiva e não-destrutiva.
-- ============================================================

alter table scr_authorizations
  -- canal da autorização: 'deps' (fluxo original) | 'internal' (autogestão Reino)
  add column if not exists channel          text not null default 'deps',
  -- código de confirmação enviado por e-mail (ex.: 9Z3WU7)
  add column if not exists auth_code         text,
  -- token público da URL de autorização (/autorizacao-scr/[token])
  add column if not exists public_token      uuid default uuid_generate_v4(),
  -- snapshot do termo LGPD apresentado ao titular (prova de consentimento)
  add column if not exists consent_text      text,
  -- nome/razão social e documento como exibidos no termo
  add column if not exists consent_name      text,
  add column if not exists consent_document  text,
  -- aceite do titular
  add column if not exists consented_at      timestamptz,
  add column if not exists consent_ip        text,
  add column if not exists refused_at        timestamptz;

do $$ begin
  alter table scr_authorizations
    add constraint scr_channel_chk check (channel in ('deps', 'internal'));
exception when duplicate_object then null; end $$;

create unique index if not exists idx_scr_public_token
  on scr_authorizations(public_token);

-- Configurações do termo (editáveis pelo admin em /settings/scr).
insert into settings (key, value, description) values
  ('scr_authorized_name',     '"Eliane Moreira - Ordem Consultoria"', 'Nome do autorizado a consultar no termo SCR'),
  ('scr_authorized_document', '"12.296.230/0001-29"',                 'CNPJ de quem opera, citado no termo SCR'),
  ('scr_institution_name',    '"Fidúcia SCMEPP"',                     'Instituição citada no termo SCR'),
  ('scr_city',                '"Criciúma - SC"',                      'Cidade/UF do local de assinatura do termo SCR')
on conflict (key) do nothing;
