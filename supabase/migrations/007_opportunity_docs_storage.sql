-- ============================================================
-- 007 — Storage para documentos de oportunidade (Fase 4)
-- Bucket privado `opportunity-docs`. Os arquivos são organizados
-- por oportunidade: <opportunity_id>/<doc_id>-<filename>.
-- Acesso restrito a staff (admin/consultant) — leitura via URL
-- assinada gerada no server. Nunca público.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('opportunity-docs', 'opportunity-docs', false)
on conflict (id) do nothing;

-- auth_role() já existe (migration 001) e roda como security definer.

-- Staff lê os objetos do bucket.
drop policy if exists "opp-docs: staff lê" on storage.objects;
create policy "opp-docs: staff lê"
  on storage.objects for select
  using (bucket_id = 'opportunity-docs' and auth_role() in ('admin', 'consultant'));

-- Staff envia (insert).
drop policy if exists "opp-docs: staff envia" on storage.objects;
create policy "opp-docs: staff envia"
  on storage.objects for insert
  with check (bucket_id = 'opportunity-docs' and auth_role() in ('admin', 'consultant'));

-- Staff atualiza/substitui.
drop policy if exists "opp-docs: staff atualiza" on storage.objects;
create policy "opp-docs: staff atualiza"
  on storage.objects for update
  using (bucket_id = 'opportunity-docs' and auth_role() in ('admin', 'consultant'));

-- Staff remove.
drop policy if exists "opp-docs: staff remove" on storage.objects;
create policy "opp-docs: staff remove"
  on storage.objects for delete
  using (bucket_id = 'opportunity-docs' and auth_role() in ('admin', 'consultant'));
