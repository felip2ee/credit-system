create index holders_bureau_type_name_idx
  on holders(bureau_id, type, name);

create index holder_partnerships_bureau_partner_idx
  on holder_partnerships(bureau_id, partner_id);

create index dossiers_bureau_kind_created_idx
  on dossiers(bureau_id, kind, created_at desc);

create index consultations_bureau_dossier_idx
  on consultations(bureau_id, dossier_id);

create index consultations_bureau_holder_date_idx
  on consultations(bureau_id, holder_id, created_at desc);

create index consultations_bureau_owner_status_date_idx
  on consultations(bureau_id, created_by, status, created_at desc);

create index consultations_bureau_document_normalized_idx
  on consultations(bureau_id, (regexp_replace(document, '\D', '', 'g')));

create index scr_authorizations_bureau_holder_idx
  on scr_authorizations(bureau_id, holder_id);

create index bureau_payloads_consultation_idx
  on bureau_payloads(consultation_id);

create index bureau_results_bureau_document_idx
  on bureau_results(bureau_id, document);

create index timeline_events_bureau_entity_idx
  on timeline_events(bureau_id, entity_type, entity_id, created_at desc);

create index audit_logs_bureau_date_idx
  on audit_logs(bureau_id, created_at desc);

create index support_sessions_active_superadmin_idx
  on support_sessions(superadmin_id)
  where ended_at is null;
