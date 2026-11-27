# Programa de afiliados e split

Runbook do split na entrada de dinheiro, dos dois modos de recebimento, do estorno, da fila de saques e do pagamento. Regras do produto: [PRODUCT.md](../../PRODUCT.md). Regra principal: [spec 2026-11-26](../superpowers/specs/2026-11-26-afiliado-bureaus-design.md). Plano: [split na entrada](../superpowers/plans/2026-11-26-afiliado-bureaus-1-split-na-entrada.md) e [telas do afiliado](../superpowers/plans/2026-11-26-afiliado-bureaus-2-telas-afiliado.md). A spec de 2026-10-24 ([link](../superpowers/specs/2026-10-24-programa-de-afiliados-design.md)) ainda vale para saque, conversão e anonimização. Não vale mais para a comissão na captura.

## 0. Antes de ligar o split

1. No Asaas de produção, habilite o split: **Integrações > Segurança**. Sem isso, o Asaas recusa o `split` das cobranças.
2. Teste um `walletId` real no sandbox antes de usar em produção. O cliente Asaas deste projeto não foi conferido em sandbox (veja o comentário em `src/lib/asaas/client.ts`). Confirme que a cobrança com split chega ao beneficiário e que o evento de split volta ao webhook.
3. Cadastre os sócios em `/superadmin/settings/socios` (`walletId` e %). Cadastre o `walletId` de cada Bureau em `/superadmin/bureaus/<id>`.
4. Aplique as migrações até a 085 (`npm run db:migrate`).

## 1. Como o split funciona

Toda cobrança Asaas criada pelo sistema leva um `split`. O split divide o valor líquido da cobrança entre os beneficiários. A plataforma fica com a sobra, na conta raiz do Asaas.

**Base de cálculo diferente por modo:** o Asaas aplica as % sobre o valor líquido (sem a taxa dele). O sistema calcula o valor de `charge_splits`, a comissão em modo Pix e o accrual do Bureau sobre o valor bruto da cobrança. Por isso uma parte em modo Pix ou accrual é maior do que a mesma % paga pelo split do Asaas, e o valor mostrado para uma linha `asaas` é uma estimativa.

- **Cobranças com split:** Pix e cartão do checkout (`src/lib/payments/checkout.ts`) e Pix de link (`src/lib/payment-links/pix.ts`).
- **Quem recebe:**

| Beneficiário | % vem de | Sem `walletId` ou em modo Pix |
|---|---|---|
| Sócio (`platform_partners`) | Cadastro do superadmin | Sempre `walletId` |
| Bureau dono do cliente | % do Bureau (`bureau_commission_rates`, ou a % global) | Sem `walletId`: accrual em `bureau_payable_entries` (repasse manual) |
| Bureau indicador (`bureau_referrals`) | % da indicação (padrão 5%, definida pelo superadmin na página do Bureau) | Sem `walletId`: accrual |
| Afiliado de link | % de afiliados do Bureau (`default_pct`; `affiliate_rates` é legado e o plano o ignora) | Modo Pix: saldo no livro-razão (seção 2) |

- **Regras de cobrança:**
  - Recarga do próprio Bureau: só sócios recebem.
  - Crédito manual e consumo de saldo: não geram split nem comissão.
  - Afiliado de link entra só se o Bureau liga o recurso (seção 3) e se o indicado tem celular verificado.
  - Soma acima de 100% recusa a cobrança (`split_over_100`).
- **Plano gravado:** o plano fica em `charge_splits`, com status `pending`. Mudar `walletId` ou o modo depois da criação não muda a cobrança já criada.
- **Pedido online novo:** a captura do pedido não cria comissão (migração 077). Pedido reservado antes da 077 mantém a regra antiga.

## 2. Os dois modos de recebimento

O beneficiário escolhe o modo em `/portal/afiliacao/pagamentos`. O Bureau indicador usa o mesmo campo, no cadastro feito pelo superadmin.

- **Conta Asaas (`asaas`):** o Asaas paga o beneficiário no split, no recebimento. Conforme a spec, a taxa do Asaas sai da parte do beneficiário.
- **Chave Pix (`pix`):** o sistema grava o saldo na confirmação do pagamento (ledger `cash_in`). A carência é `affiliate_cash_in_hold_days` (padrão 0 dia). O saldo sai pela fila de saques (seção 6). Só o afiliado de link tem este modo. O Bureau indicador recebe por `walletId` ou por accrual.

- **Painel do afiliado (`/portal/afiliacao`):** mostra as comissões dos dois modos, cada cobrança uma vez. A linha `asaas` vem de `affiliate_my_asaas_commissions()` (migração 085): "Pago na conta Asaas" só com status `done`; os outros status aparecem como estão. O valor é aproximado. Recarga recusada ou estornada não entra no total do indicado.
- **Troca de `walletId` ou de modo:** o afiliado recebe um e-mail, e a auditoria guarda o `walletId` antigo e o novo, mascarados. Não há reautenticação, prazo de espera nem aprovação.
- **`walletId` reservado:** o afiliado não pode salvar o `walletId` de um sócio ou de um Bureau.
- **Split recusado na criação:** se o Asaas responde que o split ou a `walletId` é inválido, o sistema cria a cobrança uma vez sem split. As linhas em modo Asaas dessa cobrança ficam `refused`. Uma `walletId` ruim recusa todas as linhas Asaas da cobrança. O formato do erro do Asaas não foi conferido em sandbox.

## 3. Ligar e desligar o afiliado de link

- O admin do Bureau liga ou desliga em `/afiliados` (cartão de afiliados). O padrão é desligado.
- A % de afiliados (`default_pct`) continua só do superadmin, em `/superadmin/bureaus/<id>`.
- Desligar não cancela cobranças já criadas. Vale para as próximas cobranças.

## 4. Estorno e chargeback

- **Modo conta Asaas:** o Asaas reverte o split sozinho, de forma assíncrona. A linha segue o item de `payment.split[]` (migração 083):

| Item no evento | Linha |
|---|---|
| `REFUNDED` ou `CANCELLED` | `refunded` |
| `REFUSED` em cobrança estornada | `refunded` |
| `DONE` em `PAYMENT_REFUNDED` | `reversal_failed`. Um evento posterior com `REFUNDED` ou `CANCELLED` muda para `refunded` |
| `DONE` em `PAYMENT_CHARGEBACK_REQUESTED` | Fica `done`. O painel mostra "Reversão pendente" |

- Em cobrança estornada a linha nunca fica `refused`: uma linha já recusada vira `refunded`.
- O sistema não tem prazo automático para a reversão pendente (runbook na seção 5).
- **Estorno parcial (`PAYMENT_PARTIALLY_REFUNDED`):** o sistema não reverte comissão, accrual nem saldo. O evento fica gravado como `partial_refund_ignored`. A decisão de negócio está pendente.
- **Cartão parcelado:** as parcelas 2 em diante casam pelo parcelamento (`asaas_installment_id`) e pelo `walletId`. Há uma linha por beneficiário: a recusa de uma parcela depois de `done` não aparece.
- **Evento de split antes de o sistema gravar o id do pagamento:** o webhook responde 500 só se `externalReference` é de uma cobrança deste sistema, e o Asaas reenvia. Se a fila de webhooks do Asaas parar, confira no log `split de cobrança ainda sem o id do pagamento`, reative a fila no Asaas e confirme o id em `pix_charges`.
- **Modo Pix:** o sistema lança a reversão no livro-razão (`commission_clawback`, migrações 078 e 079, `src/lib/affiliates/reversal.ts`).
  - O saldo do afiliado pode ficar negativo. O que falta é abatido das próximas comissões.
  - Com saldo menor ou igual a zero, saque e conversão são recusados (`insufficient_funds`).
- **Bureau sem `walletId`:** a reversão entra como lançamento `reversal`, ligado ao accrual.
- **Status de `charge_splits`:** `pending`, `done`, `refused`, `refunded` ou `reversal_failed`.
- **Relatórios:** `/afiliados` (Bureau) e `/superadmin/splits` (superadmin). O relatório por cliente mostra estorno, chargeback e comissão já paga sobre cobrança estornada. Os repasses e o total dos sócios contam só cobrança paga ou estornada.
- **Rótulo "A repassar":** accrual do Bureau sem `walletId`. O valor ainda não saiu. O rótulo não muda depois do repasse manual: confira o repasse na tela de repasses.

## 5. Runbook: split recusado, reversão pendente ou `reversal_failed`

O Asaas não tem o evento `PAYMENT_SPLIT_REFUSED`. A recusa chega como item de `payment.split[]` com status `REFUSED` ou `CANCELLED`. Em cobrança não estornada, o sistema grava `refused` (migrações 072 e 083, `src/lib/asaas/split-events.ts`).

**Split recusado (`refused`):**

1. Abra `/superadmin/splits` e filtre por "Recusado".
2. Veja a cobrança, o beneficiário (mascarado) e o valor.
3. No Asaas, confira o `walletId` do beneficiário e o motivo da recusa.
4. Corrija o cadastro (`/superadmin/settings/socios` ou `walletId` do Bureau). A correção vale para as próximas cobranças. A cobrança recusada não muda.
5. O sistema não refaz o repasse. Antes de pagar, confirme no Asaas que a cobrança não foi estornada, nem tem chargeback. Cobrança estornada não paga comissão: a linha vira `refunded` quando o sistema recebe o evento.
6. Com a cobrança paga e não estornada, decida com o financeiro como pagar o valor fora do sistema, e registre o pagamento.

**Reversão pendente:** chargeback pedido e repasse ainda `done`. Aparece em `/superadmin/splits`, no filtro "Repassado", com o selo "Reversão pendente". Confira no Asaas. Se o Asaas reverteu, o próximo evento muda a linha. Se não reverteu, trate como reversão falhou. Estas linhas não entram na coluna de prejuízo por reversão falha. Pix de link com chargeback mostra o mesmo selo.

**Reversão falhou (`reversal_failed`):** o pagamento foi estornado e o evento ainda trazia o repasse como feito. O Asaas reverte de forma assíncrona: a linha pode virar `refunded` depois.

1. Abra `/superadmin/splits` e filtre por "Reversão falhou".
2. Confirme o status e o valor no Asaas. Se o Asaas já reverteu, não cobre o beneficiário.
3. Decida com o financeiro como recuperar o valor. O sistema não cobra sozinho.
4. O valor aparece como prejuízo do cliente no relatório. O evento de auditoria é `charge_split.reversal_failed`.

## 6. Fila de saques (modo Pix)

Esta seção vale para o afiliado em modo Pix.

### Saque ligado e desligado

O saque nasce desligado. A flag é `AFFILIATE_WITHDRAWALS_ENABLED`: só o valor `true` liga. Desligado, o portal mostra "Saque disponível em breve." no lugar de "Sacar por PIX". O pedido de saque é recusado com "O saque ainda não está disponível.". A conversão em créditos, a carência e a fila do superadmin continuam. Para liberar, depois da validação do contador, defina `AFFILIATE_WITHDRAWALS_ENABLED=true` no deploy e reinicie o app.

**Antes de liberar saques em produção:** o contador deve validar o tratamento fiscal do saque. Este item é **(post-deploy)**. Ele não bloqueia o merge. Enquanto a validação não existir, não avise os clientes sobre a função de saque.

### Pedido de saque

1. A afiliada pede o saque em `/portal/afiliacao/saque`. Ela informa a chave PIX e declara que a chave está no nome dela.
2. A taxa de saque é a configuração `affiliate_withdrawal_fee` (valor fixo mais %). O valor líquido é o valor menos a taxa. A afiliada vê a taxa em `/portal/afiliacao` e em `/portal/afiliacao/saque`.
3. O valor sai do saldo disponível no momento do pedido.
4. A chave CPF/CNPJ precisa ser o documento da conta. O sistema recusa outra.
5. O superadmin vê os saques abertos em `/superadmin/saques`, do mais antigo ao mais novo. A chave PIX aparece mascarada. O detalhe mostra a chave completa e o documento da conta mascarado.

Com uma sessão de suporte ativa, a fila não abre. Encerre a sessão de suporte.

### Pagar fora do sistema

1. Abra o saque em `/superadmin/saques/<id>`.
2. Pague o valor líquido por PIX no banco da empresa.
3. Anexe o comprovante (PDF, PNG ou JPEG, até 5 MB). O sistema verifica o tipo e passa o antivírus.
4. Clique em **Marcar como pago** e confirme. A ação não pode ser desfeita.

Não existe repasse automático.

### Cancelar um saque

1. Abra o saque aberto.
2. Escreva o motivo (até 500 caracteres). A afiliada vê o motivo.
3. Confirme. O valor volta ao saldo disponível da afiliada.

Um saque pago não pode ser cancelado.

## 7. Runbook: zerar saldos antigos de comissão do Bureau

Os saldos de comissão do Bureau criados antes do split já foram repassados fora do sistema. Este script zera esses saldos. Ele não apaga nada.

Script: `scripts/db/zero-legacy-bureau-payables.mjs`. Usa `DATABASE_OWNER_URL`.

1. Liste. O padrão é `--dry-run`, que não grava nada:
   `node scripts/db/zero-legacy-bureau-payables.mjs`
   A primeira linha da saída é o banco alvo (host, porta e nome; nunca a senha). Confira que é o banco de produção.
2. Confira a lista, Bureau por Bureau. Saldo negativo (dívida do Bureau) aparece, mas o script não ajusta.
3. Não crie repasse (`create_payout`) antes do ajuste. Rode logo depois do deploy.
4. Grave os ajustes. O `--yes` é obrigatório junto com `--apply`:
   `node scripts/db/zero-legacy-bureau-payables.mjs --apply --yes`
   Cada Bureau recebe um lançamento `reversal`, com o motivo "Saldo anterior repassado fora do sistema (zerado por script)". Cada ajuste gera o evento `payable.legacy_zeroed`.
5. Rode o `--dry-run` de novo. Depois do ajuste, a lista fica vazia. Uma segunda execução de `--apply --yes` não grava nada.

Regras que o operador precisa saber:

- O script só zera lançamentos sem `pix_charge_id`. Qualquer lançamento com cobrança é dívida ou crédito novo e nunca é perdoado: o accrual da entrada, o estorno ligado a ele e o clawback do estorno de cobrança.
- O `reversal` conta no saldo a repassar na hora, com qualquer data. O accrual só conta depois de `payable_retention_days` (migração 046 e 047). Por isso o ajuste não volta a data do lançamento e cobre só o que já está liberado.
- Accrual antigo ainda dentro da retenção não é zerado. Ele aparece na coluna "aguardando retenção". Se isso acontecer, rode o script de novo depois que a janela passar. Se o legado já tem mais de `payable_retention_days`, nada fica aguardando.

O usuário executa este script em produção, só depois de conferir a lista.

## 8. Conversão em créditos

A afiliada converte parte do saldo disponível em créditos em `/portal/afiliacao`. Um crédito vale R$ 1. A conversão não tem taxa e não pode ser desfeita. O crédito convertido não pode ser sacado.

## 9. Anonimização (LGPD) de uma afiliada

A anonimização fica bloqueada se a afiliada tem comissão disponível ou saque aberto: ela precisa sacar antes. A comissão ainda em carência é perdida na anonimização (decisão do designer; validar com o jurídico).

## 10. Teste e2e

`e2e/affiliate.spec.ts` cobre o fluxo de link, cadastro, cobrança paga pelo webhook, comissão, conversão, saque e pagamento. O teste roda com `AFFILIATE_WITHDRAWALS_ENABLED=true`, `ASAAS_DRIVER=fake`, `ASAAS_WEBHOOK_TOKEN` e `DATABASE_WEBHOOK_URL` (definidos no `ci.yml`).
