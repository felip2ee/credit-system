# NFS-e (nota fiscal de serviço) pelo Asaas

> **AVISO FISCAL (decisão D3).** A plataforma emite uma nota para todo PIX confirmado: recarga do Bureau e recarga do cliente.
> Esse tratamento pode estar errado se a receita da plataforma nascer só no consumo do crédito.
> **O contador deve validar o tratamento fiscal antes do deploy.** Não preencha as variáveis abaixo antes dessa validação.
> Sem as variáveis, a plataforma não agenda nota e registra `not_requested`.

## Como funciona

1. O Asaas confirma o PIX e o webhook credita a carteira. Esse crédito não depende da nota.
2. Depois do crédito, fora da transação, a plataforma agenda a nota no Asaas (`POST /v3/invoices`).
3. Agendada: `nfse_status = pending`. Erro ao agendar: `failed`.
4. O Asaas avisa o resultado por evento. `INVOICE_AUTHORIZED` grava `issued` com número e link do PDF. `INVOICE_ERROR` grava `failed`.
5. Uma nota `issued` nunca volta a outro status. Um evento repetido não muda nada.
6. A falha da nota nunca altera carteira, lançamento nem resposta do webhook.
7. O superadmin vê as notas `failed` em `/superadmin/nfse` e pede nova tentativa.

## Variáveis de ambiente

Todas são lidas sob demanda. Nenhuma é obrigatória para o sistema subir.

| Variável | Obrigatória | Valor |
|---|---|---|
| `NFSE_MUNICIPAL_SERVICE_ID` | uma das duas | Id do serviço municipal no Asaas. |
| `NFSE_MUNICIPAL_SERVICE_CODE` | uma das duas | Código do serviço da prefeitura (por exemplo `1.05`). Necessário em contas do Portal Nacional. |
| `NFSE_MUNICIPAL_SERVICE_NAME` | sim, se houver serviço | Nome do serviço municipal. |
| `NFSE_SERVICE_DESCRIPTION` | sim, se houver serviço | Texto da descrição do serviço na nota. |
| `NFSE_ISS_RATE` | sim, se houver serviço | Alíquota de ISS em percentual, de 0 a 5. Exemplo: `2.5`. |
| `NFSE_RETAIN_ISS` | não | `true` ou `false`. Padrão `false`. |

- Sem `NFSE_MUNICIPAL_SERVICE_ID` e sem `NFSE_MUNICIPAL_SERVICE_CODE`: NFS-e desligada.
- Com um dos dois e uma variável obrigatória ausente ou inválida: a plataforma marca a nota como `failed` e registra o erro (só o nome do erro, sem dados).
- Os segredos do Asaas (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`) não mudam. Veja `.env.example`.

## Configuração municipal no Asaas (passo a passo para o contador)

1. Entre no painel do Asaas com a conta que recebe os PIX.
2. Abra **Notas fiscais** e conclua o cadastro fiscal da empresa. Informe razão social, CNPJ e **inscrição municipal**.
3. Informe o regime tributário. Envie o certificado digital se a prefeitura pedir.
4. Cadastre o **serviço municipal**. Escolha o código de serviço (LC 116/2003) e a alíquota de ISS.
5. Anote o id do serviço (ou o código). Use o nome exato do serviço cadastrado em `NFSE_MUNICIPAL_SERVICE_NAME`.
6. Confirme se a prefeitura aceita emissão pelo Asaas. Se aceitar o Portal Nacional, use o código em `NFSE_MUNICIPAL_SERVICE_CODE`.
7. Valide com o contador: (a) emitir nota na recarga está correto; (b) o código de serviço; (c) a alíquota; (d) a retenção de ISS.
8. Cadastre o webhook de notas no Asaas, com o mesmo endereço e o mesmo token do webhook de pagamentos (`/api/webhooks/asaas`).
   Marque os eventos `INVOICE_AUTHORIZED`, `INVOICE_ERROR`, `INVOICE_UPDATED` e `INVOICE_SYNCHRONIZED`.
9. Entregue ao time técnico: id (ou código), nome, descrição, alíquota e retenção.

## Teste antes de ligar em produção

1. Preencha as variáveis na **sandbox** do Asaas (`ASAAS_API_BASE_URL` de sandbox).
2. Faça uma recarga de teste. Espere o evento de pagamento.
3. Confira no painel do Asaas que a nota foi **agendada** para aquele pagamento.
4. Confira que `nfse_status` virou `pending` e depois `issued` (com número e link).
5. Provoque uma falha (serviço municipal inválido). Confira que o status é `failed`, que a carteira foi creditada e que a nota aparece em `/superadmin/nfse`.
6. Peça a nova tentativa e confira o resultado.

## O que a documentação do Asaas não confirmou

Conferido em 2026-10-14. Estes pontos só a prova real confirma (item `post-deploy`):

- Quais subcampos de `taxes` a prefeitura exige. A plataforma envia `retainIss` e `iss`.
- Se o campo `observations` pode ir vazio.
- Se o id do serviço municipal serve a todas as prefeituras. O código é a alternativa.
- Se os eventos de nota trazem `invoice.externalReference`. A plataforma não depende dele: casa a nota pelo pagamento (`invoice.payment`).

## Operação

- Nota `failed`: abra `/superadmin/nfse` e peça nova tentativa. Cada tentativa soma em `nfse_attempts` e gera auditoria `nfse.retry`.
- Para desligar a NFS-e: esvazie `NFSE_MUNICIPAL_SERVICE_ID` e `NFSE_MUNICIPAL_SERVICE_CODE` e reinicie o serviço. Notas já agendadas seguem no Asaas.
- A nota não gera, anula nem corrige nada na carteira. Estorno de PIX não cancela a nota: cancele no painel do Asaas.
