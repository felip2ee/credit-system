-- Enum columns (kind, status, type) stay out of keys: under RLS they never become an Index Cond.
create index holders_bureau_updated_idx
  on holders(bureau_id, updated_at desc);

create index holder_partnerships_bureau_partner_idx
  on holder_partnerships(bureau_id, partner_id);

create index dossiers_bureau_created_idx
  on dossiers(bureau_id, created_at desc);

create index dossiers_bureau_holder_idx
  on dossiers(bureau_id, holder_id, created_at desc);

create index consultations_bureau_dossier_idx
  on consultations(bureau_id, dossier_id);

create index consultations_bureau_holder_date_idx
  on consultations(bureau_id, holder_id, created_at desc);

create index consultations_bureau_created_idx
  on consultations(bureau_id, created_at desc);

-- Cache lookup: document = $1 and status = 'completed' and consulted_at >= ... order by consulted_at desc limit 1.
create index consultations_bureau_document_consulted_idx
  on consultations(bureau_id, document, consulted_at desc);

create index scr_authorizations_bureau_holder_idx
  on scr_authorizations(bureau_id, holder_id);

create index scr_authorizations_bureau_document_idx
  on scr_authorizations(bureau_id, document, requested_at desc);

create index scr_authorizations_bureau_consultation_idx
  on scr_authorizations(bureau_id, consultation_id);

create index scr_authorizations_bureau_requested_idx
  on scr_authorizations(bureau_id, requested_at desc);

create index timeline_events_bureau_entity_idx
  on timeline_events(bureau_id, entity_type, entity_id, created_at desc);

create index crm_notes_bureau_entity_idx
  on crm_notes(bureau_id, entity_id, created_at desc);

create index ai_reports_bureau_status_idx
  on ai_reports(bureau_id, status);

create index audit_logs_bureau_date_idx
  on audit_logs(bureau_id, created_at desc);

-- audit_logs_select mixes bureau and platform arms; these serve the superadmin arms.
create index audit_logs_platform_idx
  on audit_logs(created_at desc)
  where bureau_id is null;

create index audit_logs_support_idx
  on audit_logs(created_at desc)
  where support_session_id is not null;

create index support_sessions_active_superadmin_idx
  on support_sessions(superadmin_id)
  where ended_at is null;
