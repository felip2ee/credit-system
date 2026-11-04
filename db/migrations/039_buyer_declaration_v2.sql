-- Declaração do comprador, versão 2: texto sem a marca de provisório.
-- legal_documents é append-only: a versão nova entra como linha nova e a versão 1 fica no histórico.
insert into legal_documents (kind, version, title, body_md) values (
  'buyer_declaration', 2, 'Declaração do comprador',
  $md$Ao confirmar este pedido, declaro que:

- os e-mails e os celulares informados pertencem às pessoas indicadas;
- cada pessoa indicada sabe deste pedido de consulta e autorizou a consulta dos seus dados;
- tenho motivo legítimo para pedir a consulta (negócio, crédito ou análise de risco) e vou usar o resultado só para essa finalidade;
- não vou repassar o resultado a terceiros.

Sei que a plataforma registra esta declaração com data, hora e endereço IP. Respondo por qualquer informação falsa ou uso indevido do resultado, nos termos da lei (Lei Geral de Proteção de Dados, Lei nº 13.709/2018).$md$
) on conflict (kind, version) do nothing;
