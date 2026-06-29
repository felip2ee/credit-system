-- ============================================================
-- 005 — E-mail do titular persistido na consulta (Fase 5)
-- Guarda o e-mail usado para a autorização SCR na própria query, no momento
-- em que ela é enfileirada (processo de empresa). Assim o reprocessamento /
-- retomada não depende do estado do cliente — o e-mail não se perde.
-- Aditiva e não-destrutiva.
-- ============================================================

alter table queries
  add column if not exists scr_email text;
