-- Chave de idempotência para o dinheiro que sai de um clique: pedido (portal e balcão) e pagamento de balcão.
-- Falha: duplo clique, retry de rede ou voltar do navegador reenviavam o mesmo formulário e criavam dois pedidos
-- (duas reservas de saldo) ou dois pagamentos. O formulário gera um uuid por montagem e o envia; o servidor grava a
-- chave NA MESMA transação do registro. Chave repetida devolve o registro que já existe, sem cobrar de novo.
-- Tabela à parte, e não coluna em dossier_orders: o app_runtime não tem INSERT em dossier_orders (só open_order, 022) e
-- o gatilho dossier_orders_guard recusa coluna nova mutável. Uma tabela só serve os dois fluxos.
-- Corrida: INSERT ... ON CONFLICT DO NOTHING espera a transação que já tem a chave. Se ela confirma, o segundo vê o
-- conflito e devolve o registro; se ela desfaz (saldo insuficiente, erro), o segundo segue e grava a sua.
-- request_hash é o sha256 do corpo enviado: mesma chave com outro corpo não devolve o registro de outro pedido.
-- Escopo: (user_id, scope, key). Chave de outro usuário não colide nem revela nada (RLS). Linhas antigas não existem:
-- chamador sem chave (null) não grava nada aqui.
-- Retenção: uma linha pequena por envio; sem poda por ora (record_id aponta o pedido ou o pagamento).

create table if not exists idempotency_keys (
  user_id uuid not null,
  scope text not null check (scope in ('order', 'counter_payment')),
  key uuid not null,
  bureau_id uuid not null references bureaus(id),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  record_id uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, scope, key),
  foreign key (bureau_id, user_id) references profiles(bureau_id, id)
);

alter table idempotency_keys enable row level security;
alter table idempotency_keys force row level security;

-- Cada usuário lê, grava e liga ao registro só as próprias chaves, no próprio Bureau.
drop policy if exists idempotency_keys_select on idempotency_keys;
create policy idempotency_keys_select on idempotency_keys for select
  using (app_context_present() and user_id = app_user_id() and bureau_id = app_bureau_id());
drop policy if exists idempotency_keys_insert on idempotency_keys;
create policy idempotency_keys_insert on idempotency_keys for insert
  with check (app_context_present() and user_id = app_user_id() and bureau_id = app_bureau_id() and record_id is null);
drop policy if exists idempotency_keys_bind on idempotency_keys;
create policy idempotency_keys_bind on idempotency_keys for update
  using (app_context_present() and user_id = app_user_id() and bureau_id = app_bureau_id() and record_id is null)
  with check (user_id = app_user_id() and bureau_id = app_bureau_id() and record_id is not null);

revoke all on idempotency_keys from public, app_runtime;
grant select, insert (user_id, scope, key, bureau_id, request_hash), update (record_id) on idempotency_keys to app_runtime;
grant select on idempotency_keys to backup_reader;
