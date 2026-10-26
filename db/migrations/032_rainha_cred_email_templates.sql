-- Modelos de e-mail da plataforma com a identidade Rainha Cred.
-- Os modelos são imutáveis (020: só active -> retired). Para cada modelo semeado (key, channel 'email'):
-- se a versão ativa ainda é a semeada (version = 1), aposenta-a e ativa a versão 2. Modelo já
-- personalizado (versão ativa > 1) não é tocado, e rodar o arquivo de novo não faz nada.
-- Cores: tokens de src/lib/brand/tokens.ts (BRAND_COLORS). {{siteUrl}} é preenchido no envio
-- (src/lib/notifications/channels/email.ts) e não faz parte de `params`.
-- O rodapé repete o e-mail de suporte padrão (SUPPORT_EMAIL, src/lib/config.ts); mudar o domínio pede uma versão nova.

-- Sem acesso de leitura (RLS) a lista fica vazia e o loop não faria nada em silêncio: falha alto.
do $$
begin
  if not exists (select 1 from public.notification_templates where key = 'scr_authorization' and channel = 'email') then
    raise exception 'notification_templates is not readable by the migration role';
  end if;
end
$$;

create function pg_temp.brand_email_template(p_key text, p_subject text, p_title text, p_content_html text, p_text text)
returns void
language plpgsql
as $fn$
declare
  v_old public.notification_templates;
  v_html text := $layout$<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#F4EFE4;font-family:Arial, sans-serif;color:#122C2B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4EFE4;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;max-width:560px;width:100%;border-top:6px solid #009C97;">
          <tr><td style="background:#FCEDCE;text-align:center;padding:24px;">
            <img src="{{siteUrl}}/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png" alt="Rainha Cred" width="200" style="display:inline-block;width:200px;max-width:100%;height:auto;border:0;">
          </td></tr>
          <tr><td style="padding:28px 24px 0;text-align:center;">
            <h1 style="margin:0;font-family:Arial, sans-serif;font-size:24px;line-height:1.3;font-weight:700;color:#007A76;">[[title]]</h1>
          </td></tr>
          <tr><td style="padding:16px 24px 28px;text-align:center;font-family:Arial, sans-serif;font-size:18px;line-height:1.5;color:#122C2B;">
[[content]]
          </td></tr>
          <tr><td style="background:#122C2B;padding:18px 24px;text-align:center;font-family:Arial, sans-serif;font-size:14px;line-height:1.5;color:#FCEDCE;">
            Rainha Cred · suporte@rainhacred.com.br
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>$layout$;
begin
  select * into v_old from public.notification_templates
   where key = p_key and channel = 'email' and status = 'active';
  if not found or v_old.version <> 1 then
    return;
  end if;

  update public.notification_templates set status = 'retired' where id = v_old.id;
  insert into public.notification_templates (key, channel, version, params, email_subject, email_html, email_text)
  values (
    p_key, 'email', v_old.version + 1, v_old.params, p_subject,
    replace(replace(v_html, '[[title]]', p_title), '[[content]]', p_content_html),
    p_text || E'\n\nRainha Cred · suporte@rainhacred.com.br'
  );
end
$fn$;

select pg_temp.brand_email_template(
  'scr_authorization',
  $tpl$Autorização de consulta SCR — Rainha Cred$tpl$,
  $tpl$Autorização de consulta SCR$tpl$,
  $tpl$            <p style="margin:0 0 8px;">Olá {{clientName}},</p>
            <p style="margin:0 0 24px;">A {{authorizedName}} gostaria de realizar a consulta SCR dos seus dados. Use o código abaixo para autorizar.</p>
            <p style="margin:0 0 8px;font-size:16px;color:#4A5E5D;">Seu código de confirmação:</p>
            <div style="margin:0 auto 8px;max-width:280px;border:2px dashed #007A76;border-radius:8px;background:#FCEDCE;padding:16px 12px;font-family:Arial, sans-serif;font-size:32px;font-weight:700;letter-spacing:8px;color:#122C2B;">{{code}}</div>
            <p style="margin:0 0 24px;font-size:14px;color:#4A5E5D;">Toque e segure (ou selecione) o código para copiar.</p>
            <a href="{{url}}" style="display:inline-block;background:#007A76;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:18px;padding:14px 28px;border-radius:8px;">Autorizar consulta</a>
            <p style="margin:24px 0 0;font-size:14px;color:#4A5E5D;">Se o botão não funcionar, acesse: <br/><a href="{{url}}" style="color:#007A76;">{{url}}</a></p>$tpl$,
  $tpl$Olá {{clientName}},

A {{authorizedName}} gostaria de realizar a consulta SCR dos seus dados.
Seu código de confirmação: {{code}}

Autorize em: {{url}}$tpl$
);

select pg_temp.brand_email_template(
  'email_verification',
  $tpl$Confirme seu e-mail — Rainha Cred$tpl$,
  $tpl$Confirme seu e-mail$tpl$,
  $tpl$            <p style="margin:0 0 24px;">Olá, {{clientName}}.</p>
            <a href="{{url}}" style="display:inline-block;background:#007A76;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:18px;padding:14px 28px;border-radius:8px;">Confirmar e-mail</a>
            <p style="margin:24px 0 0;font-size:14px;color:#4A5E5D;">Se o botão não funcionar, acesse: <br/><a href="{{url}}" style="color:#007A76;">{{url}}</a></p>
            <p style="margin:24px 0 0;font-size:14px;color:#4A5E5D;">O link vale por 24 horas.</p>
            <p style="margin:8px 0 0;font-size:14px;color:#4A5E5D;">Se você não criou esta conta, ignore este e-mail.</p>$tpl$,
  $tpl$Olá, {{clientName}}.

Confirme seu e-mail em: {{url}}

O link vale por 24 horas.
Se você não criou esta conta, ignore este e-mail.$tpl$
);

select pg_temp.brand_email_template(
  'research_released',
  $tpl$Sua pesquisa está disponível$tpl$,
  $tpl$Sua pesquisa está disponível$tpl$,
  $tpl$            <p style="margin:0 0 24px;">Olá, {{clientName}}. O resultado da sua pesquisa já pode ser consultado.</p>
            <a href="{{url}}" style="display:inline-block;background:#007A76;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:18px;padding:14px 28px;border-radius:8px;">Ver pesquisa</a>
            <p style="margin:24px 0 0;font-size:14px;color:#4A5E5D;">Se o botão não funcionar, acesse: <br/><a href="{{url}}" style="color:#007A76;">{{url}}</a></p>$tpl$,
  $tpl$Olá, {{clientName}}.

O resultado da sua pesquisa já pode ser consultado.

Acesse em: {{url}}$tpl$
);

select pg_temp.brand_email_template(
  'platform_test',
  $tpl$Teste de envio — Plataforma Bureau$tpl$,
  $tpl$Teste de envio$tpl$,
  $tpl$            <p style="margin:0;">Este é um e-mail de teste da Plataforma Bureau. Nenhuma ação é necessária.</p>$tpl$,
  $tpl$Este é um e-mail de teste da Plataforma Bureau. Nenhuma ação é necessária.$tpl$
);

drop function pg_temp.brand_email_template(text, text, text, text, text);
