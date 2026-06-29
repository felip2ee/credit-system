-- ============================================================
-- Reino do Crédito — Migration 001: Schema Inicial
-- Baseado na estrutura real da API deps.com.br
-- PJ: Smart PJ 010 | PF: Smart PF 002
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

create type user_role as enum ('admin', 'consultant', 'client');
create type query_type as enum ('PF', 'PJ');
create type query_status as enum (
  'pending_authorization',
  'authorized',
  'processing',
  'completed',
  'error',
  'rejected'
);
create type batch_status as enum (
  'pending', 'processing', 'completed', 'completed_with_errors', 'cancelled'
);
create type authorization_action as enum ('approved', 'rejected', 'info_requested');

-- ============================================================
-- PROFILES
-- ============================================================

create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null,
  email        text not null,
  role         user_role not null default 'consultant',
  avatar_url   text,
  is_active    boolean not null default true,
  mfa_enabled  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
-- CLIENTS
-- ============================================================

create table clients (
  id              uuid primary key default uuid_generate_v4(),
  type            query_type not null,
  cpf             text unique,
  nome_completo   text,
  data_nascimento date,
  cnpj            text unique,
  razao_social    text,
  nome_fantasia   text,
  email           text,
  telefone        text,
  observacoes     text,
  is_active       boolean not null default true,
  user_id         uuid references profiles(id) on delete set null,
  created_by      uuid not null references profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chk_pf_fields check (type = 'PJ' or (cpf is not null and nome_completo is not null)),
  constraint chk_pj_fields check (type = 'PF' or (cnpj is not null and razao_social is not null))
);

-- ============================================================
-- BATCHES (declarada antes de queries por causa da FK)
-- ============================================================

create table batches (
  id              uuid primary key default uuid_generate_v4(),
  name            text,
  type            query_type not null,
  product         text,
  created_by      uuid not null references profiles(id),
  status          batch_status not null default 'pending',
  total_items     int not null default 0,
  processed_items int not null default 0,
  success_items   int not null default 0,
  error_items     int not null default 0,
  file_name       text,
  file_path       text,
  report_path     text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ============================================================
-- QUERIES
-- ============================================================

create table queries (
  id                    uuid primary key default uuid_generate_v4(),
  type                  query_type not null,
  document              text not null,
  document_name         text,
  product               text,
  client_id             uuid references clients(id) on delete set null,
  batch_id              uuid references batches(id) on delete set null,
  created_by            uuid not null references profiles(id),
  status                query_status not null default 'pending_authorization',
  requires_auth         boolean not null default false,
  observations          text,
  -- Preenchidos após execução na API
  historico_consulta_id text,
  consulted_at          timestamptz,
  api_version           int,
  product_version       text,
  is_partial            boolean,
  share_link            text,
  error_message         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ============================================================
-- QUERY_RESULTS_PJ
-- Baseado em: Smart PJ 010 (471 campos / deps.com.br)
-- ============================================================

create table query_results_pj (
  id         uuid primary key default uuid_generate_v4(),
  query_id   uuid not null unique references queries(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- ─── EMPRESA (mix.empresa.data.*) ───────────────────────
  cnpj                          text,
  cnpj_matriz                   text,
  tipo_unidade                  text,
  razao_social                  text,
  nome_fantasia                 text,
  situacao_cadastral            text,
  data_situacao_cadastral       timestamptz,
  data_inicio_atividade         date,
  data_inicio_atividade_matriz  date,
  motivo_situacao_cadastral     text,
  natureza_juridica             text,
  cnae_principal                text,
  cnaes_secundarios             jsonb,    -- ["4644301 - COMERCIO ATACADISTA...", ...]
  endereco                      text,
  numero                        text,
  bairro                        text,
  complemento                   text,
  cep                           text,
  uf                            char(2),
  municipio                     text,
  municipio_codigo_ibge         text,
  qualificacao_responsavel      text,
  capital_social                numeric(15,2),
  capital_social_matriz         numeric(15,2),
  porte                         text,
  quantidade_funcionarios       int,
  opcao_pelo_simples            text,
  data_opcao_pelo_simples       date,
  data_exclusao_opcao_simples   date,
  opcao_mei                     text,
  situacao_especial             text,
  data_situacao_especial        date,
  nome_ente_federativo          text,
  quantidade_filiais            int,
  nire                          text,

  -- ─── SCORE (mix.score.data.*) ────────────────────────────
  score_valor                   int,
  score_risco                   text,
  score_descricao               text,
  score_probabilidade_pagamento numeric(5,2),
  score_descricao_pagamento     text,
  score_boleto                  numeric(5,2),
  score_motivos                 jsonb,

  -- ─── FLAGS RISCO ─────────────────────────────────────────
  restricao                     text,
  falencias_recuperacao         jsonb,

  -- ─── CHEQUES (mix.restricoesCheques.*) ───────────────────
  cheques_possui_informacao     boolean,
  cheques_alertas               jsonb,
  cheques_devolvidos_sem_fundo  jsonb,
  cheques_devolvidos_outros     jsonb,
  cheques_sustados              jsonb,
  cheques_informados_usuario    jsonb,

  -- ─── PENDÊNCIAS (mix.pendenciasRestricoes.*) ─────────────
  pendencias_success            boolean,
  pendencias_message            text,
  pendencias_data               jsonb,

  -- ─── AÇÕES JUDICIAIS (mix.acoesJudiciais.*) ──────────────
  acoes_judiciais_success       boolean,
  acoes_judiciais_message       text,
  acoes_judiciais_data          jsonb,

  -- ─── PROTESTOS (mix.protestos.*) ─────────────────────────
  protestos_success             boolean,
  protestos_message             text,
  protestos_data                jsonb,

  -- ─── QUADRO SOCIETÁRIO (mix.quadroSocietario.*) ──────────
  quadro_societario_com_participacao boolean,
  quadro_societario_socios      jsonb,
  -- [{cnpjEmpresa, participacao, nome, documento, dataEntrada, dataSaida,
  --   cargoSociedade, cidade, uf, cep, alerta, restricao, situacao, socios}]

  -- ─── CONTATOS PREFERENCIAIS ──────────────────────────────
  contatos_preferenciais        jsonb,
  -- [{whatsapp, telefone, documento, nome, operadora, procon,
  --   cidade, uf, bairro, rua, numero, complemento}]

  -- ─── OUTROS ENDEREÇOS ────────────────────────────────────
  outros_enderecos              jsonb,
  -- [{endereco, numero, complemento, cep, uf, municipio, bairro}]

  -- ─── EMAILS ──────────────────────────────────────────────
  emails                        jsonb,    -- ["email@x.com", ...]

  -- ─── FATURAMENTO PRESUMIDO ───────────────────────────────
  faturamento_presumido_success boolean,
  faturamento_presumido_message text,
  faturamento_presumido_data    jsonb,

  -- ─── SCR ─────────────────────────────────────────────────
  -- PJ: dado simples (apenas mensagem, sem detalhamento de carteira)
  scr_success                   boolean,
  scr_message                   text,
  scr_data                      jsonb,

  -- ─── CONSULTAS ANTERIORES ────────────────────────────────
  consultas_anteriores_success  boolean,
  consultas_anteriores_message  text,
  consultas_anteriores_data     jsonb,

  -- ─── PARTICIPAÇÃO EM EMPRESA ─────────────────────────────
  participacao_empresa_success  boolean,
  participacao_empresa_message  text,
  participacao_empresa_data     jsonb,

  -- ─── RELAÇÃO EMPRESA/SÓCIO ───────────────────────────────
  relacao_empresa_socio_success boolean,
  relacao_empresa_socio_message text,
  relacao_empresa_socio_data    jsonb,

  -- ─── SMART (mix.smart.*) ─────────────────────────────────
  smart_success                 boolean,
  smart_message                 text,
  smart_classificacao           jsonb,
  -- {classificacao, limiteSugerido, limiteRequisitado, validade,
  --  pontuacaoAtingida, politicaId, politica, ticketMedio, porte}
  smart_positivas               jsonb,   -- [{metrica, descricao, pontuacao, impacto, percentualMetrica}]
  smart_negativas               jsonb,
  smart_todas_classificacoes    jsonb,   -- faixas E..AAA: [{nome, pontuacaoAtingida, limiteExigido, ...}]
  smart_dados_complementares    jsonb,
  smart_parecer                 jsonb,
  -- {aprovado, motivo, limiteRequisitado,
  --  resultadoParecer: [{id, nome, atendido, percentual, percentualEsperado, descricao, regras:[...]}]}
  smart_erros_metricas          jsonb,
  smart_historico_classificacao jsonb,

  -- ─── DEMAIS MÓDULOS ──────────────────────────────────────
  sintegra                      jsonb,
  suframa                       jsonb,
  indicadores                   jsonb,
  indicadores_boleto            jsonb,
  renda_presumida               jsonb,
  gasto_estimado                jsonb,
  analise_risco                 jsonb,
  comportamental                jsonb,
  comportamental_resumido       jsonb,
  comportamental_pagamento      jsonb,
  comportamental_consumo        jsonb,
  rede_relacionamento_socio     jsonb,
  consultas_detalhadas          jsonb,
  vinculo_empregaticio          jsonb,
  grupo_componentes             jsonb,
  is_grupo                      boolean,
  share                         jsonb,
  deps_ia                       jsonb,

  -- ─── RAW ─────────────────────────────────────────────────
  raw_response                  jsonb
);

-- ============================================================
-- QUERY_RESULTS_PF
-- Baseado em: Smart PF 002 (829 campos / deps.com.br)
-- PF tem módulos exclusivos: pessoa, rendaPresumida, SCR detalhado
-- ============================================================

create table query_results_pf (
  id         uuid primary key default uuid_generate_v4(),
  query_id   uuid not null unique references queries(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- ─── PESSOA (mix.pessoa.data.*) ──────────────────────────
  -- Equivalente ao mix.empresa da PJ
  cpf                           text,
  nome                          text,
  identidade                    text,
  nome_mae                      text,
  idade                         int,
  situacao_cadastral            text,    -- REGULAR / SUSPENSA / CANCELADA / etc.
  data_nascimento               date,
  escolaridade                  text,
  nacionalidade                 text,
  data_inscricao                date,
  data_hora_receita             timestamptz,
  codigo_controle_receita       text,
  obito                         boolean,
  politicamente_exposta         boolean,
  -- Endereço cadastral principal (mix.pessoa.data.dadosCadastrais.*)
  endereco                      text,
  numero                        text,
  complemento                   text,
  bairro                        text,
  cep                           text,
  uf                            char(2),
  cidade                        text,

  -- ─── SCORE (mix.score.data.*) ────────────────────────────
  score_valor                   int,
  score_risco                   text,
  score_descricao               text,
  score_probabilidade_pagamento numeric(5,2),
  score_descricao_pagamento     text,
  score_boleto                  numeric(5,2),
  score_motivos                 jsonb,

  -- ─── RENDA PRESUMIDA (mix.rendaPresumida.data.*) ─────────
  -- Exclusivo PF — não existe no PJ
  renda_presumida_descricao     text,    -- "Entre R$ 16.200,00 e R$ 18.200,00"
  renda_presumida_valor_minimo  numeric(12,2),
  renda_presumida_valor_maximo  numeric(12,2),
  renda_presumida_valor         numeric(12,2),
  renda_possui_gasto_estimado   boolean,
  gasto_estimado                numeric(12,2),

  -- ─── SCR DETALHADO (mix.scr.data.*) ──────────────────────
  -- PF tem SCR muito mais rico que PJ: vencimentos, modalidades, carteira
  scr_success                   boolean,
  scr_message                   text,
  -- Consolidado de vencimentos
  scr_vencimentos_info_consulta jsonb,
  -- [{descricao, valor}] — Data-Base, Qtd operações, Qtd IFs, etc.
  scr_a_vencer_total            numeric(15,2),
  scr_a_vencer_percentual       text,
  scr_a_vencer_itens            jsonb,
  -- [{descricao, valor, percentual}] — faixas: até 30 dias, 31-60, etc.
  scr_vencido_total             numeric(15,2),
  scr_vencido_percentual        text,
  scr_vencido_itens             jsonb,
  -- Vencimento por modalidade
  scr_por_modalidade            jsonb,
  -- {vencimentoPorModalidades: [{descricaoTotal, valorTotal, percentualTotal, itens:[...]}],
  --  carteiraAtiva, prejuizo, carteiraCredito, repasseInterfinanceiro,
  --  coobrigacao, responsabilidadeTotal, creditoLiberar, limiteCredito,
  --  riscoIndireto, riscoAssumido, riscoTotal, coobrigacaoRecebida}
  scr_risco_total               numeric(15,2),   -- campo mais usado nos filtros
  scr_carteira_ativa            numeric(15,2),
  scr_limite_credito            numeric(15,2),

  -- ─── AÇÕES JUDICIAIS (mix.acoesJudiciais.*) ──────────────
  -- PF tem ocorrências detalhadas (requerido, ação, foro, vara, autor, processo...)
  acoes_judiciais_success       boolean,
  acoes_judiciais_message       text,
  acoes_judiciais_total         int,
  acoes_judiciais_valor_total   numeric(15,2),
  acoes_judiciais_data_primeiro date,
  acoes_judiciais_ocorrencias   jsonb,
  -- [{requerido, acao, documento, foro, uf, vara, autor, processo, distribuicao, valor, comarca}]

  -- ─── PENDÊNCIAS (mix.pendenciasRestricoes.*) ─────────────
  -- PF tem detalhamento de credores e ocorrências
  pendencias_success            boolean,
  pendencias_message            text,
  pendencias_total              int,
  pendencias_total_credores     int,
  pendencias_valor_total        numeric(15,2),
  pendencias_valor_primeiro     numeric(15,2),
  pendencias_data_primeiro      date,
  pendencias_nivel              text,    -- "Nível 3 de cobertura"
  pendencias_ocorrencias        jsonb,
  -- [{informante, tipo, cidade, uf, documentoOrigem, valor, data, ...}]

  -- ─── CONSULTAS ANTERIORES (mix.consultas.*) ──────────────
  -- PF tem contagem por período detalhada
  consultas_success             boolean,
  consultas_ultimos_15_dias     int,
  consultas_ultimos_30_dias     int,
  consultas_ultimos_31_60_dias  int,
  consultas_ultimos_61_90_dias  int,
  consultas_90_dias_mais        int,
  consultas_detalhes            jsonb,   -- [{dataConsulta, quantidadeConsultas, segmento}]

  -- ─── CHEQUES (mix.restricoesCheques.*) ───────────────────
  cheques_possui_informacao     boolean,
  cheques_alertas               jsonb,
  cheques_devolvidos_sem_fundo  jsonb,
  cheques_devolvidos_outros     jsonb,
  cheques_sustados              jsonb,
  cheques_informados_usuario    jsonb,

  -- ─── PROTESTOS (mix.protestos.*) ─────────────────────────
  protestos_success             boolean,
  protestos_message             text,
  protestos_data                jsonb,

  -- ─── PARTICIPAÇÃO EM EMPRESA (mix.participacaoEmpresa.*) ─
  -- Exclusivo PF — lista de CNPJs onde a pessoa é sócia
  participacao_empresa_success  boolean,
  participacao_empresa_message  text,
  participacao_empresa_data     jsonb,
  -- [{nome, percentualParticipacao, cnpj, dataEntrada, cargo,
  --   endereco, cidade, bairro, cep, uf, situacaoReceita,
  --   dataUltimaAtualizacao, restricao, documentoSocio, nomeSocio}]

  -- ─── CONTATOS PREFERENCIAIS ──────────────────────────────
  contatos_preferenciais        jsonb,
  -- PF retorna mais contatos (até ~10) vs PJ (~2)

  -- ─── OUTROS ENDEREÇOS ────────────────────────────────────
  outros_enderecos              jsonb,
  -- PF retorna histórico longo de endereços (até ~10 registros)

  -- ─── EMAILS ──────────────────────────────────────────────
  emails                        jsonb,

  -- ─── SMART (mix.smart.*) ─────────────────────────────────
  smart_success                 boolean,
  smart_message                 text,
  smart_classificacao           jsonb,
  smart_positivas               jsonb,
  smart_negativas               jsonb,
  smart_todas_classificacoes    jsonb,
  smart_dados_complementares    jsonb,
  smart_parecer                 jsonb,
  smart_erros_metricas          jsonb,
  smart_historico_classificacao jsonb,

  -- ─── FLAGS ───────────────────────────────────────────────
  restricao                     text,
  falencias_recuperacao         jsonb,

  -- ─── DEMAIS MÓDULOS ──────────────────────────────────────
  relacao_empresa_socio_success boolean,
  relacao_empresa_socio_message text,
  relacao_empresa_socio_data    jsonb,
  sintegra                      jsonb,
  indicadores                   jsonb,
  indicadores_boleto            jsonb,
  analise_risco                 jsonb,
  comportamental                jsonb,
  comportamental_resumido       jsonb,
  comportamental_pagamento      jsonb,
  comportamental_consumo        jsonb,
  rede_relacionamento_socio     jsonb,
  consultas_detalhadas          jsonb,
  vinculo_empregaticio          jsonb,
  grupo_componentes             jsonb,
  is_grupo                      boolean,
  share                         jsonb,
  deps_ia                       jsonb,

  -- ─── RAW ─────────────────────────────────────────────────
  raw_response                  jsonb
);

-- ============================================================
-- AUTHORIZATIONS
-- ============================================================

create table authorizations (
  id            uuid primary key default uuid_generate_v4(),
  query_id      uuid not null unique references queries(id) on delete cascade,
  requested_by  uuid not null references profiles(id),
  reviewed_by   uuid references profiles(id),
  action        authorization_action,
  justification text,
  reviewed_at   timestamptz,
  expires_at    timestamptz,
  is_urgent     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

create table notifications (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references profiles(id) on delete cascade,
  title       text not null,
  body        text,
  type        text,
  is_read     boolean not null default false,
  related_id  uuid,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- AUDIT_LOGS
-- ============================================================

create table audit_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references profiles(id) on delete set null,
  action      text not null,
  table_name  text,
  record_id   uuid,
  old_data    jsonb,
  new_data    jsonb,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- SETTINGS
-- ============================================================

create table settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references profiles(id),
  updated_at  timestamptz not null default now()
);

insert into settings (key, value, description) values
  ('auth_limit_auto_approval', '0',                          'Valor R$ p/ aprovação automática (0 = sempre exige)'),
  ('batch_throttle_ms',        '1000',                       'Intervalo ms entre chamadas à API no lote'),
  ('query_sla_hours',          '24',                         'Prazo horas para aprovação de pendentes'),
  ('mfa_required_roles',       '["admin", "consultant"]',    'Roles que exigem MFA');

-- ============================================================
-- INDEXES
-- ============================================================

create index idx_queries_status       on queries(status);
create index idx_queries_type         on queries(type);
create index idx_queries_document     on queries(document);
create index idx_queries_created_by   on queries(created_by);
create index idx_queries_client_id    on queries(client_id);
create index idx_queries_batch_id     on queries(batch_id);
create index idx_queries_consulted_at on queries(consulted_at desc);

create index idx_results_pj_query     on query_results_pj(query_id);
create index idx_results_pj_cnpj      on query_results_pj(cnpj);
create index idx_results_pj_score     on query_results_pj(score_valor);
create index idx_results_pj_situacao  on query_results_pj(situacao_cadastral);
create index idx_pj_quadro_gin        on query_results_pj using gin(quadro_societario_socios);
create index idx_pj_smart_gin         on query_results_pj using gin(smart_parecer);

create index idx_results_pf_query     on query_results_pf(query_id);
create index idx_results_pf_cpf       on query_results_pf(cpf);
create index idx_results_pf_score     on query_results_pf(score_valor);
create index idx_results_pf_situacao  on query_results_pf(situacao_cadastral);
create index idx_pf_participacao_gin  on query_results_pf using gin(participacao_empresa_data);
create index idx_pf_smart_gin         on query_results_pf using gin(smart_parecer);

create index idx_batches_status       on batches(status);
create index idx_batches_created_by   on batches(created_by);
create index idx_notifications_user   on notifications(user_id, is_read);
create index idx_audit_action         on audit_logs(action);
create index idx_audit_created        on audit_logs(created_at desc);
create index idx_clients_cpf          on clients(cpf);
create index idx_clients_cnpj         on clients(cnpj);

-- ============================================================
-- TRIGGERS — updated_at
-- ============================================================

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_profiles_updated_at      before update on profiles      for each row execute function set_updated_at();
create trigger trg_clients_updated_at       before update on clients       for each row execute function set_updated_at();
create trigger trg_queries_updated_at       before update on queries       for each row execute function set_updated_at();
create trigger trg_authorizations_updated_at before update on authorizations for each row execute function set_updated_at();
create trigger trg_batches_updated_at       before update on batches       for each row execute function set_updated_at();

-- ============================================================
-- RLS
-- ============================================================

alter table profiles          enable row level security;
alter table clients           enable row level security;
alter table queries           enable row level security;
alter table query_results_pj  enable row level security;
alter table query_results_pf  enable row level security;
alter table authorizations    enable row level security;
alter table batches           enable row level security;
alter table notifications     enable row level security;
alter table audit_logs        enable row level security;
alter table settings          enable row level security;

create or replace function auth_role()
returns user_role language sql security definer stable
set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;

-- profiles
create policy "profiles: leitura própria"    on profiles for select using (id = auth.uid());
create policy "profiles: admin lê todos"     on profiles for select using (auth_role() = 'admin');
create policy "profiles: atualização própria" on profiles for update using (id = auth.uid());

-- clients
create policy "clients: staff lê"      on clients for select using (auth_role() in ('admin','consultant'));
create policy "clients: client lê próprio" on clients for select using (user_id = auth.uid());
create policy "clients: staff cria"    on clients for insert with check (auth_role() in ('admin','consultant'));
create policy "clients: staff atualiza" on clients for update using (auth_role() in ('admin','consultant'));

-- queries
create policy "queries: staff lê"      on queries for select using (auth_role() in ('admin','consultant'));
create policy "queries: client lê próprias" on queries for select using (
  auth_role() = 'client' and client_id in (select id from clients where user_id = auth.uid()));
create policy "queries: consultant cria" on queries for insert with check (auth_role() in ('admin','consultant'));
create policy "queries: admin atualiza" on queries for update using (auth_role() = 'admin');
create policy "queries: consultant atualiza própria" on queries for update
  using (auth_role() = 'consultant' and created_by = auth.uid());

-- results pj
create policy "results_pj: staff lê" on query_results_pj for select using (auth_role() in ('admin','consultant'));
create policy "results_pj: client lê próprio" on query_results_pj for select using (
  auth_role() = 'client' and query_id in (
    select q.id from queries q join clients c on c.id = q.client_id where c.user_id = auth.uid()));

-- results pf
create policy "results_pf: staff lê" on query_results_pf for select using (auth_role() in ('admin','consultant'));
create policy "results_pf: client lê próprio" on query_results_pf for select using (
  auth_role() = 'client' and query_id in (
    select q.id from queries q join clients c on c.id = q.client_id where c.user_id = auth.uid()));

-- authorizations
create policy "authorizations: admin full"         on authorizations for all using (auth_role() = 'admin');
create policy "authorizations: consultant lê próprias" on authorizations for select
  using (auth_role() = 'consultant' and requested_by = auth.uid());

-- batches
create policy "batches: staff lê"      on batches for select using (auth_role() in ('admin','consultant'));
create policy "batches: consultant cria" on batches for insert with check (auth_role() in ('admin','consultant'));
create policy "batches: admin atualiza" on batches for update using (auth_role() = 'admin');
create policy "batches: consultant atualiza própria" on batches for update
  using (auth_role() = 'consultant' and created_by = auth.uid());

-- notifications
create policy "notifications: lê próprias"     on notifications for select using (user_id = auth.uid());
create policy "notifications: atualiza próprias" on notifications for update using (user_id = auth.uid());

-- audit
create policy "audit: admin lê" on audit_logs for select using (auth_role() = 'admin');

-- settings
create policy "settings: staff lê"    on settings for select using (auth_role() in ('admin','consultant'));
create policy "settings: admin atualiza" on settings for update using (auth_role() = 'admin');

-- ============================================================
-- AUTO-CREATE PROFILE
-- ============================================================

create or replace function handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.email,
    coalesce((new.raw_user_meta_data->>'role')::public.user_role, 'consultant')
  );
  return new;
end; $$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ============================================================
-- Migration 001 — Parte 2: CRM, Oportunidades e Agente IA
-- ============================================================

-- ============================================================
-- CREDIT_PRODUCTS
-- Catálogo de produtos de crédito ofertados pelo escritório
-- ============================================================

create table credit_products (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,           -- "Capital de Giro", "Crédito Pessoal", etc.
  type          query_type not null,     -- PF ou PJ
  description   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

insert into credit_products (name, type, description) values
  ('Capital de Giro',          'PJ', 'Crédito para capital de giro empresarial'),
  ('Antecipação de Recebíveis','PJ', 'Antecipação de duplicatas e recebíveis'),
  ('FINAME / BNDES',           'PJ', 'Financiamento de máquinas e equipamentos'),
  ('Crédito com Garantia PJ',  'PJ', 'Crédito com imóvel ou veículo como garantia'),
  ('Crédito Pessoal',          'PF', 'Crédito pessoal sem consignação'),
  ('Consignado Privado',       'PF', 'Crédito consignado em folha privada'),
  ('Crédito com Garantia PF',  'PF', 'Crédito com imóvel ou veículo como garantia');

-- ============================================================
-- CLIENTS_CRM
-- Entidade central do CRM — relacionamento comercial
-- Diferente de `clients` (que é só o vínculo com consultas),
-- esta tabela é o cliente como negócio, com agrupamento de
-- CPFs/CNPJs e histórico de relacionamento
-- ============================================================

create table crm_clients (
  id                uuid primary key default uuid_generate_v4(),
  type              query_type not null,   -- PF ou PJ

  -- Identificação principal
  name              text not null,         -- nome completo ou razão social
  document          text,                  -- CPF ou CNPJ principal (único por cliente)

  -- Contato
  email             text,
  phone             text,

  -- Endereço
  address           text,
  address_number    text,
  address_complement text,
  neighborhood      text,
  city              text,
  state             char(2),
  zip_code          text,

  -- Status no CRM
  status            text not null default 'prospect',
  -- prospect | active | in_intermediation | completed | inactive

  -- Responsável
  assigned_to       uuid references profiles(id) on delete set null,

  -- Vínculo com usuário autenticado (portal futuro)
  user_id           uuid references profiles(id) on delete set null,

  notes             text,
  created_by        uuid not null references profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- CRM_CLIENT_DOCUMENTS
-- Agrupamento de CPFs e CNPJs sob um mesmo cliente CRM
-- Ex: João Silva (PF) pode ter CPF próprio + CNPJ da empresa dele
-- ============================================================

create table crm_client_documents (
  id          uuid primary key default uuid_generate_v4(),
  client_id   uuid not null references crm_clients(id) on delete cascade,
  type        query_type not null,
  document    text not null,       -- CPF ou CNPJ (só números)
  label       text,                -- "CPF pessoal", "Empresa principal", etc.
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (client_id, document)
);

-- ============================================================
-- CRM_CLIENT_RELATIONS
-- Relacionamentos entre clientes CRM
-- Ex: PF sócia de PJ, cônjuge, grupo econômico
-- ============================================================

create table crm_client_relations (
  id              uuid primary key default uuid_generate_v4(),
  client_id       uuid not null references crm_clients(id) on delete cascade,
  related_id      uuid not null references crm_clients(id) on delete cascade,
  relation_type   text not null,
  -- socio | conjuge | avalista | grupo_economico | responsavel
  percentage      numeric(5,2),   -- percentual de participação (sócios)
  role            text,           -- cargo na empresa (sócios)
  created_at      timestamptz not null default now(),
  unique (client_id, related_id, relation_type)
);

-- ============================================================
-- AI_REPORTS
-- Pareceres técnicos gerados pelo agente de IA
-- Um por consulta, vinculado também ao cliente CRM
-- ============================================================

create table ai_reports (
  id                    uuid primary key default uuid_generate_v4(),
  query_id              uuid not null unique references queries(id) on delete cascade,
  crm_client_id         uuid references crm_clients(id) on delete set null,

  -- Classificação principal
  aptitude_status       text not null default 'pending',
  -- pending | apt | apt_with_caveats | inapt

  -- Parecer estruturado
  executive_summary     text,         -- resumo executivo em linguagem natural
  positive_points       jsonb,        -- [{title, description}]
  risk_points           jsonb,        -- [{title, description, severity}]
  action_plan           jsonb,        -- [{step, description, priority}]
  suggested_products    jsonb,        -- [{product_name, justification}]

  -- Limites sugeridos pelo agente (com base no Smart)
  suggested_limit       numeric(15,2),
  suggested_limit_notes text,

  -- Controle de geração
  model_used            text,         -- ex: "claude-sonnet-4-6"
  prompt_version        text,         -- versão do prompt usado
  generated_at          timestamptz,
  generation_error      text,

  -- Edição pelo consultor
  reviewed_by           uuid references profiles(id),
  reviewed_at           timestamptz,
  consultant_notes      text,         -- complemento do consultor

  -- Status do parecer
  status                text not null default 'generating',
  -- generating | completed | error | reviewed

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ============================================================
-- OPPORTUNITIES
-- Oportunidade de intermediação de crédito
-- Nasce de uma consulta com resultado apto
-- ============================================================

create table opportunities (
  id                uuid primary key default uuid_generate_v4(),
  crm_client_id     uuid not null references crm_clients(id) on delete cascade,
  query_id          uuid references queries(id) on delete set null,
  ai_report_id      uuid references ai_reports(id) on delete set null,
  credit_product_id uuid references credit_products(id) on delete set null,
  assigned_to       uuid references profiles(id) on delete set null,
  created_by        uuid not null references profiles(id),

  -- Pipeline
  status            text not null default 'new',
  -- new | documentation | analysis | sent_to_partner | approved | rejected | completed | cancelled

  -- Informações do crédito (PJ) — conforme checklist definido
  credit_purpose    text,           -- finalidade do crédito
  requested_amount  numeric(15,2),  -- valor solicitado
  monthly_revenue   numeric(15,2),  -- faturamento médio mensal

  -- Dados do responsável PJ (podem vir do cadastro do cliente)
  responsible_name        text,
  responsible_email       text,
  responsible_phone       text,
  responsible_cpf         text,
  responsible_birth_date  date,
  responsible_mother_name text,

  -- Endereço do crédito (pode diferir do cadastro)
  address           text,
  address_number    text,
  address_complement text,
  neighborhood      text,
  city              text,
  state             char(2),
  zip_code          text,

  -- CNPJ da empresa (PJ)
  cnpj              text,

  -- Informações PF — estrutura preparada, campos a definir
  pf_extra_data     jsonb,          -- flexível para checklist PF futuro

  -- Parceiro / instituição destino
  partner_name      text,           -- ex: "Banco X", "Fintech Y"
  partner_notes     text,

  -- Resultado
  approved_amount   numeric(15,2),  -- valor aprovado (pode diferir do solicitado)
  rejection_reason  text,

  -- Comissão (opcional, fase futura)
  commission_rate   numeric(5,2),   -- percentual
  commission_amount numeric(15,2),  -- valor calculado

  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- OPPORTUNITY_DOCUMENTS
-- Documentos do checklist por oportunidade
-- ============================================================

create table opportunity_documents (
  id              uuid primary key default uuid_generate_v4(),
  opportunity_id  uuid not null references opportunities(id) on delete cascade,

  -- Tipo do documento (baseado no checklist)
  doc_type        text not null,
  -- personal_id | revenue_proof_12m | address_proof | cnpj_card | other

  label           text not null,   -- nome amigável: "Documento pessoal", etc.
  status          text not null default 'pending',
  -- pending | uploaded | approved | rejected

  -- Arquivo (Supabase Storage)
  file_name       text,
  file_path       text,
  file_size       int,
  file_mime       text,
  uploaded_by     uuid references profiles(id),
  uploaded_at     timestamptz,

  rejection_reason text,
  reviewed_by     uuid references profiles(id),
  reviewed_at     timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ============================================================
-- TIMELINE_EVENTS
-- Log imutável de eventos para clientes e oportunidades
-- Fonte de verdade da timeline do CRM
-- ============================================================

create type timeline_entity_type as enum ('crm_client', 'opportunity', 'query');

create table timeline_events (
  id            uuid primary key default uuid_generate_v4(),
  entity_type   timeline_entity_type not null,
  entity_id     uuid not null,

  -- Tipo do evento
  event_type    text not null,
  -- client.created | client.status_changed | query.executed | query.apt |
  -- ai_report.generated | opportunity.created | opportunity.status_changed |
  -- document.uploaded | document.approved | document.rejected |
  -- note.added | scr.requested | scr.authorized

  title         text not null,         -- título legível do evento
  description   text,                  -- detalhes opcionais
  metadata      jsonb,                 -- dados extras estruturados (ex: {from: 'new', to: 'documentation'})

  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- CRM_NOTES
-- Anotações manuais do consultor vinculadas a qualquer entidade
-- ============================================================

create table crm_notes (
  id            uuid primary key default uuid_generate_v4(),
  entity_type   timeline_entity_type not null,
  entity_id     uuid not null,
  content       text not null,
  created_by    uuid not null references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- INDEXES — novas tabelas
-- ============================================================

create index idx_crm_clients_document   on crm_clients(document);
create index idx_crm_clients_status     on crm_clients(status);
create index idx_crm_clients_assigned   on crm_clients(assigned_to);
create index idx_crm_docs_client        on crm_client_documents(client_id);
create index idx_crm_docs_document      on crm_client_documents(document);
create index idx_crm_relations_client   on crm_client_relations(client_id);
create index idx_crm_relations_related  on crm_client_relations(related_id);
create index idx_ai_reports_query       on ai_reports(query_id);
create index idx_ai_reports_client      on ai_reports(crm_client_id);
create index idx_ai_reports_aptitude    on ai_reports(aptitude_status);
create index idx_opportunities_client   on opportunities(crm_client_id);
create index idx_opportunities_status   on opportunities(status);
create index idx_opportunities_assigned on opportunities(assigned_to);
create index idx_opp_docs_opportunity   on opportunity_documents(opportunity_id);
create index idx_opp_docs_status        on opportunity_documents(status);
create index idx_timeline_entity        on timeline_events(entity_type, entity_id);
create index idx_timeline_created       on timeline_events(created_at desc);
create index idx_notes_entity           on crm_notes(entity_type, entity_id);

-- ============================================================
-- TRIGGERS — updated_at novas tabelas
-- ============================================================

create trigger trg_crm_clients_updated_at
  before update on crm_clients
  for each row execute function set_updated_at();

create trigger trg_ai_reports_updated_at
  before update on ai_reports
  for each row execute function set_updated_at();

create trigger trg_opportunities_updated_at
  before update on opportunities
  for each row execute function set_updated_at();

create trigger trg_opp_docs_updated_at
  before update on opportunity_documents
  for each row execute function set_updated_at();

create trigger trg_crm_notes_updated_at
  before update on crm_notes
  for each row execute function set_updated_at();

-- ============================================================
-- RLS — novas tabelas
-- ============================================================

alter table credit_products        enable row level security;
alter table crm_clients            enable row level security;
alter table crm_client_documents   enable row level security;
alter table crm_client_relations   enable row level security;
alter table ai_reports             enable row level security;
alter table opportunities          enable row level security;
alter table opportunity_documents  enable row level security;
alter table timeline_events        enable row level security;
alter table crm_notes              enable row level security;

-- credit_products — leitura pública para staff
create policy "credit_products: staff lê" on credit_products for select
  using (auth_role() in ('admin', 'consultant'));
create policy "credit_products: admin gerencia" on credit_products for all
  using (auth_role() = 'admin');

-- crm_clients — staff vê todos, client vê o próprio
create policy "crm_clients: staff lê" on crm_clients for select
  using (auth_role() in ('admin', 'consultant'));
create policy "crm_clients: client lê próprio" on crm_clients for select
  using (auth_role() = 'client' and user_id = auth.uid());
create policy "crm_clients: staff cria/atualiza" on crm_clients for insert
  with check (auth_role() in ('admin', 'consultant'));
create policy "crm_clients: staff atualiza" on crm_clients for update
  using (auth_role() in ('admin', 'consultant'));

-- crm_client_documents
create policy "crm_docs: staff" on crm_client_documents for all
  using (auth_role() in ('admin', 'consultant'));

-- crm_client_relations
create policy "crm_relations: staff" on crm_client_relations for all
  using (auth_role() in ('admin', 'consultant'));

-- ai_reports — staff lê todos, client lê próprios
create policy "ai_reports: staff lê" on ai_reports for select
  using (auth_role() in ('admin', 'consultant'));
create policy "ai_reports: client lê próprio" on ai_reports for select
  using (auth_role() = 'client' and crm_client_id in (
    select id from crm_clients where user_id = auth.uid()));
create policy "ai_reports: staff atualiza" on ai_reports for update
  using (auth_role() in ('admin', 'consultant'));

-- opportunities
create policy "opportunities: staff lê" on opportunities for select
  using (auth_role() in ('admin', 'consultant'));
create policy "opportunities: client lê própria" on opportunities for select
  using (auth_role() = 'client' and crm_client_id in (
    select id from crm_clients where user_id = auth.uid()));
create policy "opportunities: staff gerencia" on opportunities for insert
  with check (auth_role() in ('admin', 'consultant'));
create policy "opportunities: staff atualiza" on opportunities for update
  using (auth_role() in ('admin', 'consultant'));

-- opportunity_documents
create policy "opp_docs: staff" on opportunity_documents for all
  using (auth_role() in ('admin', 'consultant'));

-- timeline_events — imutável, só insert e select
create policy "timeline: staff lê" on timeline_events for select
  using (auth_role() in ('admin', 'consultant'));
create policy "timeline: client lê própria" on timeline_events for select
  using (auth_role() = 'client'); -- filtro adicional via app
create policy "timeline: insert" on timeline_events for insert
  with check (auth_role() in ('admin', 'consultant'));

-- crm_notes
create policy "notes: staff" on crm_notes for all
  using (auth_role() in ('admin', 'consultant'));
