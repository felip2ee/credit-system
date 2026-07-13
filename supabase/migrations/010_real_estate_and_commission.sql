-- ============================================================
-- 010 — Financiamento Imobiliário + comissão configurável (Fase 6)
-- • Adiciona o produto "Financiamento Imobiliário" e mantém ativos apenas
--   os produtos EM ESCOPO hoje (que têm template de checklist):
--   "Capital de Giro" (PJ — análise bancária) e "Financiamento Imobiliário".
--   Os demais produtos do seed inicial ficam ocultos (entram depois).
-- • Semeia a taxa de comissão bruta padrão estimada (editável em
--   /settings/commission), usada no Dashboard de desempenho.
-- ============================================================

-- Produtos que permanecem ativos (em escopo). Manter em sincronia com
-- PRODUCT_DOC_SLOTS em src/types/app.ts + REAL_ESTATE_PRODUCT_NAME.
-- 1) Cria o produto de Financiamento Imobiliário se ainda não existir.
--    (credit_products não tem unique em name → usa NOT EXISTS.)
insert into credit_products (name, type, description, is_active)
select
  'Financiamento Imobiliário',
  'PF',
  'Financiamento imobiliário — imóvel novo ou usado',
  true
where not exists (
  select 1 from credit_products where name = 'Financiamento Imobiliário'
);

-- 2) Oculta os produtos fora de escopo (mantém o histórico; só some do
--    seletor que filtra is_active = true).
update credit_products
set is_active = false
where name not in ('Capital de Giro', 'Financiamento Imobiliário');

-- 3) Garante os produtos em escopo ativos (idempotente — reativa o Capital de
--    Giro caso uma execução anterior desta migration o tenha desligado).
update credit_products
set is_active = true
where name in ('Capital de Giro', 'Financiamento Imobiliário');

-- 4) Comissão bruta padrão estimada (% do valor aprovado) — editável pelo admin.
insert into settings (key, value, description)
values (
  'default_commission_rate',
  '6',
  'Comissão bruta padrão estimada (% do valor aprovado) usada no Dashboard'
)
on conflict (key) do nothing;
