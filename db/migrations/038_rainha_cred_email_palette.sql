-- Paleta nova nos modelos de e-mail Rainha Cred (tokens de src/lib/brand/tokens.ts, BRAND_COLORS).
-- Os modelos são imutáveis (020: só active -> retired). Para cada modelo semeado pela 032 (key, channel 'email'):
-- se a versão ativa ainda é a da 032 (version = 2, com o HTML de cores antigas), aposenta-a e ativa a versão 3.
-- Só as cores do HTML mudam: assunto, texto, params, fonte, logo, e-mail de suporte e marcadores ficam iguais.
-- Modelo já personalizado (versão ativa > 2) não é tocado, e rodar o arquivo de novo não faz nada.
-- Mapa de cores (antigo -> novo):
--   botão  #007A76 / texto #FFFFFF -> ouro #CFA968 / texto #2A1F0A (ctaForeground)
--   título, link, borda do código  #007A76 -> primary #0A3329
--   barra superior  #009C97 -> ouro #CFA968
--   fundo da página  #F4EFE4 -> cream #F4EAD7
--   faixa do logo  #FCEDCE -> background #FBF8F2 (o logo é verde-azulado: precisa de fundo claro)
--   caixa do código  #FCEDCE -> cream #F4EAD7;  texto do rodapé  #FCEDCE -> cream #F4EAD7
--   rodapé  #122C2B -> brand #05261F;  texto  #122C2B -> ink #123029
--   texto secundário  #4A5E5D -> mutedForeground #33514A

-- Sem acesso de leitura (RLS) a lista fica vazia e o loop não faria nada em silêncio: falha alto.
do $$
begin
  if not exists (select 1 from public.notification_templates where key = 'scr_authorization' and channel = 'email') then
    raise exception 'notification_templates is not readable by the migration role';
  end if;
end
$$;

do $$
declare
  v_old public.notification_templates;
  v_key text;
begin
  foreach v_key in array array['scr_authorization', 'email_verification', 'research_released', 'platform_test'] loop
    select * into v_old from public.notification_templates
     where key = v_key and channel = 'email' and status = 'active';
    if not found or v_old.version <> 2 or position('#009C97' in v_old.email_html) = 0 then
      continue;
    end if;
    -- Já existe a versão 3 (re-execução parcial ou manual): não cria outra nem aposenta a 2.
    if exists (select 1 from public.notification_templates where key = v_key and channel = 'email' and version = v_old.version + 1) then
      continue;
    end if;

    -- Só toca a linha que ainda é a versão 2 ativa.
    update public.notification_templates set status = 'retired'
     where id = v_old.id and status = 'active' and version = 2;
    insert into public.notification_templates (key, channel, version, params, email_subject, email_html, email_text)
    select
      v_key, 'email', v_old.version + 1, v_old.params, v_old.email_subject,
      -- A ordem importa: pares específicos antes das trocas simples.
      replace(replace(replace(replace(replace(replace(replace(replace(replace(
        v_old.email_html,
        'background:#007A76;color:#FFFFFF', 'background:#CFA968;color:#2A1F0A'),
        '#007A76', '#0A3329'),
        '#009C97', '#CFA968'),
        'background:#FCEDCE;text-align:center;padding:24px', 'background:#FBF8F2;text-align:center;padding:24px'),
        '#FCEDCE', '#F4EAD7'),
        'background:#122C2B', 'background:#05261F'),
        '#122C2B', '#123029'),
        '#F4EFE4', '#F4EAD7'),
        '#4A5E5D', '#33514A'),
      v_old.email_text
    where not exists (
      select 1 from public.notification_templates
       where key = v_key and channel = 'email' and version = v_old.version + 1
    );
  end loop;
end
$$;
