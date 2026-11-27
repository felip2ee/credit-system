# Afiliado entre bureaus e afiliado de link com repasse Asaas ou Pix

Data: 2026-11-26. Branch: `feat/afiliado-bureaus`. Status: aguardando aprovação.

## Intenção

- O bureau A indica o bureau B. A recebe 5% do faturamento bruto de B, como afiliado.
- Dentro de um bureau, o dono pode ativar afiliados de link (uma pessoa, um link). Esse recurso fica oculto até o dono ligar.
- Cada beneficiário (bureau indicador ou afiliado de link) escolhe como recebe:
  - **Conta Asaas:** repasse na hora, por split do Asaas. A taxa do Asaas sai da parte do beneficiário.
  - **Chave Pix:** retenção de 30 dias, depois saque por Pix (fluxo atual).

## Regra principal (revisada em 2026-11-26)

- A comissão incide só sobre dinheiro que entra pela plataforma por cobrança Asaas (recarga, pedido, cartão, boleto, link de pagamento). Crédito manual e consumo de saldo não geram comissão.
- O split nasce na criação da cobrança (o Asaas não aceita split em cobrança já paga). Beneficiário em modo `asaas` recebe pelo split no recebimento. Beneficiário em modo `pix` recebe saldo na confirmação do pagamento, com carência configurável (padrão 0 dia) e saque por Pix.
- Estorno: o Asaas reverte o split sozinho. Em modo Pix, o sistema registra a reversão. O painel mostra estorno e chargeback por cliente.
- A base é o valor líquido da cobrança. Participam do split, na criação da cobrança: sócios (cadastro no superadmin, com `walletId` e percentual), bureau dono do cliente, bureau indicador e afiliado de link. A plataforma fica com a sobra na conta raiz. A comissão da captura do pedido (`capture_order`) sai. Saldos antigos de comissão do bureau são zerados por lançamento de ajuste auditado.
- Esta regra substitui os textos abaixo sobre "faturamento bruto da venda" e "carência de 30 dias". Decisões fechadas e calls do assistente estão em `docs/superpowers/plans/2026-11-26-afiliado-bureaus-1-split-na-entrada.md`.

## Camadas de repasse (texto original, superado pela regra principal)

Todas incidem sobre o faturamento bruto da venda:

1. Repasse geral (sócios do superadmin): padrão, em tudo que é vendido.
2. Repasse do bureau dono da venda.
3. Bureau indicador: 5% do bruto de B (valor padrão; ajustável pelo superadmin).
4. Afiliado de link do bureau (opcional).

A soma das camadas não pode passar de 100% do bruto. `lockCommissionSplit` e `assertSplitWithin100` continuam impondo o teto.

## Objetivos

- Indicação entre bureaus com 5% do bruto, sem prazo final.
- Toggle por bureau para a seção de afiliado. Desligado: `/portal/afiliacao` não aparece para o cliente final.
- Tela "Configurar pagamentos" com dois cards (Conta Asaas e Chave Pix), com benefícios e custos claros, e botões para a Play Store e a App Store.
- Reaproveitar o livro-razão, a carência e o saque atuais para o modo Pix.

## Fora do escopo

- Mudar o repasse geral e o repasse do bureau que já existem.
- Afiliado de vários níveis (bureau indicado por bureau indicado).
- Pagamento de afiliado por outro meio que não Asaas ou Pix.

## Anti-objetivos

- Uma venda pagar mais de 100% do bruto.
- Um split Asaas sem registro no livro-razão e na auditoria.
- A seção de afiliado visível com o toggle desligado.

## Abordagens

- **A. Estender o sistema de afiliados atual (escolhida).** Cada beneficiário ganha `payout_method` (`asaas` ou `pix`). Modo Asaas: o `walletId` entra no split da cobrança, sem carência. Modo Pix: carteira, carência de 30 dias e saque atuais. Menos código novo. Contra: dois caminhos de pagamento em `capture_order` e em `src/lib/asaas/client.ts`.
- **B. Módulo separado só para o split Asaas.** Isolado, mas duplica regras de comissão e teto em dinheiro. Rejeitada.

## Decisões

- Tabela nova `bureau_referrals` (bureau indicador, bureau indicado, `pct`, ativo). Um bureau tem no máximo um indicador. Auto-indicação é proibida.
- Coluna `payout_method` e `asaas_wallet_id` nos beneficiários (afiliado de link e bureau). Chave Pix continua no fluxo de saque atual.
- Flag `affiliate_enabled` em `bureau_affiliate_settings`, padrão `false`. O dono liga em `(dashboard)/afiliados` ou nas configurações.
- Modo Asaas grava no livro-razão uma entrada já liquidada, para auditoria e relatório. Não há saldo a sacar.
- Todo split e toda mudança de modo geram evento de auditoria na mesma transação. `walletId` e chave Pix aparecem mascarados em logs.
- Migração: `db/migrations/062_*.sql`. Nunca editar migração aplicada.

## Pontos para o construtor verificar

- Fatos confirmados na documentação do Asaas (docs.asaas.com, 2026):
  - Estorno de cobrança com split reverte os repasses de forma automática. O campo `refundedSplits[].done` mostra se cada reversão ocorreu.
  - O split é calculado sobre `netValue` (após taxas). O restante fica com o dono da cobrança. O split roda no recebimento; não há data de liberação configurável. O webhook `PAYMENT_SPLIT_DONE` avisa a conclusão.
  - O recebedor obtém o próprio `walletId` por `GET /v3/wallets/` com a chave dele. Não existe API para validar o `walletId` de terceiros.
  - O split precisa estar habilitado na conta (Integrações > Segurança).
- Não documentado pelo Asaas, a tratar como risco: chargeback com split, saldo insuficiente do recebedor na reversão e taxas por recebedor. Regra proposta: o bureau dono da venda cobre qualquer reversão que o Asaas não consiga fazer, e o sistema registra a divergência na auditoria.
- Como o `walletId` não tem validação, a tela mostra o ID mascarado para o usuário confirmar e o primeiro split é conferido pelo webhook `PAYMENT_SPLIT_DONE` / `REFUSED`.
- Os links das lojas (Play Store e App Store) do app Asaas. O construtor confirma os links oficiais.
- Onde cada bureau guarda sua conta Asaas hoje. Não foi encontrado no código.

## Calls do assistente (não confirmadas por você)

- 5% é o padrão, ajustável pelo superadmin.
- Bureau indicador usa os mesmos dois modos de recebimento.
- Carência de 30 dias fixa. Hoje ela é configurável (`affiliate_commission_hold_days`). Eu manteria o valor configurável com padrão 30.

## Testes

- Teto de 100% com todas as camadas ativas.
- Split Asaas montado com `walletId` e percentuais corretos.
- Modo Pix respeita a carência de 30 dias.
- Toggle desligado esconde a seção e bloqueia a Server Action.
- Indicação circular e auto-indicação rejeitadas.
- Isolamento entre bureaus (RLS).
