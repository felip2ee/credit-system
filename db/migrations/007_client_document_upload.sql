-- Client uploads stay inside the authenticated RLS identity. A client may
-- update only an existing, owned document slot with clean scan metadata.

create or replace function protect_client_document_upload()
returns trigger
language plpgsql
as $$
begin
  if app_user_role() = 'client' then
    if old.status = 'approved'
      or new.status <> 'uploaded'
      or new.uploaded_by is distinct from app_user_id()
      or new.scan_result <> 'clean'
      or new.object_key is null
      or new.file_path is distinct from new.object_key
      or new.sha256 is null
      or new.sha256 !~ '^[0-9a-f]{64}$'
      or new.byte_size is null
      or new.byte_size < 1
      or new.file_size is distinct from new.byte_size
      or new.file_mime is distinct from new.detected_mime
      or new.file_name is null
      or new.uploaded_at is null
      or new.rejection_reason is not null
      or to_jsonb(new) - array[
        'status', 'file_name', 'file_path', 'file_size', 'file_mime',
        'uploaded_by', 'uploaded_at', 'rejection_reason', 'updated_at',
        'object_key', 'sha256', 'byte_size', 'detected_mime', 'scan_result',
        'scan_version'
      ] is distinct from to_jsonb(old) - array[
        'status', 'file_name', 'file_path', 'file_size', 'file_mime',
        'uploaded_by', 'uploaded_at', 'rejection_reason', 'updated_at',
        'object_key', 'sha256', 'byte_size', 'detected_mime', 'scan_result',
        'scan_version'
      ] then
      raise exception 'client document upload may update only scanned metadata';
    end if;
  end if;
  return new;
end
$$;

alter function protect_client_document_upload() owner to schema_owner;
revoke all on function protect_client_document_upload() from public;
grant execute on function protect_client_document_upload() to app_runtime;

create trigger protect_client_document_upload
  before update on opportunity_documents
  for each row execute function protect_client_document_upload();

create policy opportunity_documents_client_upload
  on opportunity_documents for update
  using (
    app_context_present()
    and app_user_role() = 'client'
    and status <> 'approved'
    and exists (
      select 1
      from opportunities
      join crm_clients on crm_clients.id = opportunities.crm_client_id
      where opportunities.id = opportunity_documents.opportunity_id
        and crm_clients.user_id = app_user_id()
    )
  )
  with check (
    app_context_present()
    and app_user_role() = 'client'
    and status = 'uploaded'
    and uploaded_by = app_user_id()
    and scan_result = 'clean'
    and exists (
      select 1
      from opportunities
      join crm_clients on crm_clients.id = opportunities.crm_client_id
      where opportunities.id = opportunity_documents.opportunity_id
        and crm_clients.user_id = app_user_id()
    )
  );

create or replace function protect_client_opportunity_documentation()
returns trigger
language plpgsql
as $$
begin
  if app_user_role() = 'client' and (
    old.status <> 'new'
    or new.status <> 'documentation'
    or to_jsonb(new) - array['status', 'updated_at']
       is distinct from to_jsonb(old) - array['status', 'updated_at']
    or not exists (
      select 1 from opportunity_documents
      where opportunity_id = old.id and status <> 'pending'
    )
  ) then
    raise exception 'client may advance only an uploaded opportunity to documentation';
  end if;
  return new;
end
$$;

alter function protect_client_opportunity_documentation() owner to schema_owner;
revoke all on function protect_client_opportunity_documentation() from public;
grant execute on function protect_client_opportunity_documentation() to app_runtime;

create trigger protect_client_opportunity_documentation
  before update on opportunities
  for each row execute function protect_client_opportunity_documentation();

create policy opportunities_client_documentation_update on opportunities for update
  using (
    app_context_present()
    and app_user_role() = 'client'
    and status = 'new'
    and exists (
      select 1 from crm_clients
      where crm_clients.id = opportunities.crm_client_id
        and crm_clients.user_id = app_user_id()
    )
  )
  with check (
    app_context_present()
    and app_user_role() = 'client'
    and status = 'documentation'
    and exists (
      select 1 from crm_clients
      where crm_clients.id = opportunities.crm_client_id
        and crm_clients.user_id = app_user_id()
    )
  );

create policy timeline_events_client_document_upload on timeline_events for insert
  with check (
    app_context_present()
    and app_user_role() = 'client'
    and created_by = app_user_id()
    and event_type in ('document.uploaded', 'opportunity.status_changed')
    and (
      (entity_type = 'opportunity' and exists (
        select 1
        from opportunities
        join crm_clients on crm_clients.id = opportunities.crm_client_id
        where opportunities.id = timeline_events.entity_id
          and crm_clients.user_id = app_user_id()
      ))
      or (entity_type = 'crm_client' and exists (
        select 1 from crm_clients
        where crm_clients.id = timeline_events.entity_id
          and crm_clients.user_id = app_user_id()
      ))
    )
  );

create policy audit_logs_client_document_upload on audit_logs for insert
  with check (
    app_context_present()
    and app_user_role() = 'client'
    and user_id = app_user_id()
    and action = 'document.upload'
    and table_name = 'opportunity_documents'
    and outcome in ('success', 'failure')
    and exists (
      select 1
      from opportunity_documents
      join opportunities on opportunities.id = opportunity_documents.opportunity_id
      join crm_clients on crm_clients.id = opportunities.crm_client_id
      where opportunity_documents.id = audit_logs.record_id
        and crm_clients.user_id = app_user_id()
    )
  );
