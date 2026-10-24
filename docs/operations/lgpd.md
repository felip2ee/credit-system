# LGPD: retenção e pedidos do titular

Este runbook descreve o que a plataforma guarda, por quanto tempo, e como a equipe atende um pedido do titular. Não é parecer jurídico.

Os prazos são hipóteses (decisão D4 do [spec do M7](../superpowers/specs/2026-10-16-m7-producao-design.md)). Valide-os com o contador ou o advogado antes do primeiro deploy de produção.

## 1. Tabela de retenção

| Dado | Tabelas | Prazo | Ação no M7 |
|---|---|---|---|
| Código de verificação | `verification_challenges`, `verification` | 24 h após `expires_at` | Apagar (varredura) |
| Tentativa de cadastro por IP | `client_register_attempts` | 30 dias | Apagar (varredura) |
| Sessão expirada | `session` | 24 h após `expires_at` | Apagar (varredura) |
| Notificação | `notifications` | Já existe (migration 020) | Nada |
| Titular, consulta, payload, resultado, parecer, dossiê, notas, timeline | `holders`, `consultations`, `bureau_payloads`, `bureau_results`, `ai_reports`, `dossiers`, `crm_notes`, `timeline_events`, `dossier_orders.subject_name` | 5 anos após a última atividade, ou a pedido | Anonimizar (função) |
| Autorização SCR | `scr_authorizations` | 5 anos após `expires_at` | Apagar (varredura) |
| Pedido, razão, pagamento, repasse, NFS-e, webhook Asaas | `dossier_orders`, `order_settlements`, `*_ledger_entries`, `counter_payments`, `payouts`, `asaas_webhook_events` | 5 anos (fiscal) | Manter |
| Auditoria | `audit_logs` | 5 anos | Manter (append-only) |
| Aceite de termos | `legal_acceptances` | Conta + 5 anos | Manter |

A "última atividade" de um Titular é a data mais recente entre a atualização do Titular, a conclusão de um dossiê e a data de uma consulta. A varredura do Bureau usa essa data.

## 2. O que fica e por quê (D5)

Exclusão a pedido significa anonimização. A plataforma não apaga as linhas de prova e de controle fiscal:

- **Autorização SCR:** prova do consentimento do titular.
- **Razão, pagamentos, repasses, NFS-e e webhooks:** obrigação fiscal (LGPD, art. 16, I). Os prazos são hipótese (seção 1).
- **`audit_logs`:** trilha de quem fez o quê. Append-only.
- **Aceite de termos:** prova do aceite.

Os campos de identificação saem. O nome e o documento do titular deixam de existir nas tabelas de consulta, de resultado e de parecer.

## 3. Atender um pedido

O prazo de resposta é de **15 dias**. Quem atende é o admin do Bureau (`bureau_admin`), que tem a permissão `lgpd:manage`. Não há autoatendimento no portal (D6).

1. Confirme a identidade de quem pede antes de agir. O spec não define o canal de pedido. Defina o canal na operação.
2. Abra a ficha do Titular em `/holders/[id]`. A seção **LGPD** aparece para quem tem `lgpd:manage`.
3. Para entregar os dados, clique em **Exportar dados**. O navegador baixa `titular-<id>.json`. O arquivo traz o titular, as parcerias, os dossiês, os pareceres, as consultas com o resultado, as autorizações SCR sem o código de autorização e sem o link público, os pedidos, a timeline e as notas. Não traz dados de outro titular. A exportação grava `lgpd.export_holder`.
4. Para excluir os dados do titular, clique em **Anonimizar titular**. Informe o motivo com 10 a 500 caracteres. A ação grava `lgpd.anonymize_holder` com o motivo. Ela não tem volta.
5. Se o titular tem conta de cliente (`client_profile_id`), a seção oferece **Anonimizar conta do cliente**. Informe o motivo. A ação grava `lgpd.anonymize_client_account`.
6. Registre o pedido, a data e o resultado no sistema de tickets da operação.

### Recusas

| Função | Retorno | Significado |
|---|---|---|
| `lgpd_anonymize_holder` | `open_orders` | Há pedido aberto para o titular. Espere o pedido terminar. |
| `lgpd_anonymize_holder` | `already_anonymized` | O titular já foi anonimizado. |
| `lgpd_anonymize_holder` | `not_found` | O titular não existe ou é de outro Bureau. |
| `lgpd_anonymize_client_account` | `balance` | A conta tem saldo diferente de zero. |
| `lgpd_anonymize_client_account` | `open_orders` | A conta tem pedido aberto. |
| `lgpd_anonymize_client_account` | `already_anonymized` | A conta já foi anonimizada. |
| `lgpd_anonymize_client_account` | `not_found` | A conta não existe ou é de outro Bureau. |

## 4. O que a anonimização faz

**Titular (`lgpd_anonymize_holder`):**

- Troca o nome por `Titular anonimizado` e apaga documento, e-mail, telefone, endereço, bairro, cidade, UF, CEP e notas.
- Marca `anonymized_at`. A ficha mostra o selo **Anonimizado em <data>** e esconde Editar, Nova consulta e Acesso ao portal.
- Apaga o resultado e o payload DEPS das consultas. Zera o texto e o JSON de pareceres e dossiês.
- Apaga as notas de CRM e zera a descrição e os metadados da timeline.
- Troca `subject_name` dos pedidos por `Titular anonimizado`. Não altera outro campo do pedido.

**Conta do cliente (`lgpd_anonymize_client_account`):**

- Troca nome e e-mail por valores genéricos. Desativa o login.
- Apaga as sessões, as contas de login, o 2FA e os códigos de verificação do usuário.
- Não toca os titulares que essa conta comprou. Titulares de terceiros não são anonimizados em cascata (D7).

## 5. Limpeza automática

O tick de pedidos (`POST /api/internal/orders/tick`) roda a varredura:

- `lgpd_purge_technical`: apaga código de verificação, tentativa de cadastro e sessão expirados. Roda a cada rodada, sempre, com `pg_try_advisory_xact_lock`.
- `lgpd_purge_bureau`: roda só com `LGPD_PURGE_ENABLED=1`. O padrão é desligado, até o jurídico aprovar os prazos de retenção (spec D4). Quando ligada, roda no máximo uma vez a cada 24 h e processa até 100 titulares por Bureau por execução. Para cada Bureau ativo, anonimiza titulares sem atividade há 5 anos e sem pedido aberto. Apaga autorizações SCR com mais de 5 anos desde o fim da vigência, a recusa ou o pedido sem resposta. Antes de apagar uma autorização, a consulta perde a referência a ela.

A varredura é idempotente. Ela grava `lgpd.purge_bureau` em toda execução, mesmo sem contagem, e esse registro controla o intervalo de 24 h.

## 6. Limites

- A anonimização não tem volta. Confirme o pedido antes de clicar.
- `audit_logs`, razão, pagamentos e webhooks não são apagados depois de 5 anos. Isso fica fora do M7.
- O portal não tem botões de exportação ou de exclusão. O cliente depende do Bureau (D6).
- O e2e e os testes de integração cobrem a anonimização e a exportação. Veja [quality.md](../quality.md).
