-- ============================================================
-- 011 — Modo de autorização SCR por consulta
-- Registra como a autorização SCR foi gerida em cada consulta:
--   'internal' → autogestão: NÓS coletamos o consentimento (termo + código por
--                e-mail); a consulta envia `autorizacaoScr=true` (a deps cadastra
--                a autorização no momento da consulta).
--   'deps'     → a própria deps verifica a autorização dela; a consulta envia
--                `autorizacaoScr=false` (400 se não houver autorização registrada).
-- Persistir o modo garante que reprocessamento/reverificação honrem a escolha
-- original em vez de cair sempre em 'internal'. Aditiva e não-destrutiva.
-- ============================================================

alter table queries
  add column if not exists scr_mode text not null default 'internal'
    check (scr_mode in ('internal', 'deps'));
