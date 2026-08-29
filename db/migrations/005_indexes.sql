create index consultations_owner_status_date_idx
  on consultations(created_by, status, created_at desc);

create index consultations_client_date_idx
  on consultations(crm_client_id, created_at desc);

create index consultations_document_normalized_idx
  on consultations ((regexp_replace(document, '\D', '', 'g')));

create index bureau_payloads_consultation_idx
  on bureau_payloads(consultation_id);

create index bureau_results_document_idx
  on bureau_results(document);
