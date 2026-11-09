# Pagamento por pagador (Pix e cartão) via Asaas — design

> Substitui `2026-11-03-asaas-card-payments-design.md`. As regras de cartão daquele spec continuam válidas e estão repetidas aqui quando mudam algo.

## Resultado

Cada cobrança Asaas (Pix ou cartão) pertence a um cliente Asaas do pagador real. A NFS-e sai no nome e no CPF/CNPJ de quem pagou. O checkout das duas recargas pergunta quem paga, pede só os dados que faltam e aceita Pix ou cartão em até 12x. CPF/CNPJ, CEP e número do endereço do dono da conta ficam cifrados no banco (AES-256-GCM). O Bureau nunca lê o documento completo de um cliente.

## Escopo

- Recarga da carteira do Bureau: `src/actions/wallet-topup.ts`, `src/components/wallet/TopupDialog.tsx`.
- Recarga do cliente no portal: `src/actions/credits-topup.ts`, `src/components/credits/ClientTopupDialog.tsx`.
- Cliente Asaas: `src/lib/asaas/`.
- Banco: migrations `040` em diante.
- Instalador e stack: `scripts/setup/`, `docker-stack.yml`, `.env.example`.
- Documentos: lista na seção "Documentos que mudam".

## Decisões do operador (fechadas)

1. Um cliente Asaas por pagador. `ASAAS_CUSTOMER_ID` sai do sistema.
2. Cartão no app (sem página hospedada), até 12x, o pagador paga a taxa.
3. O checkout pergunta: "Os dados de pagamento são os do dono da conta ou outros?" (rádio).
4. Dados do dono: CPF/CNPJ, CEP e número cifrados no banco (AES-256-GCM, chave em Docker secret `PII_ENCRYPTION_KEY`, coluna de id da chave). O registro guarda `asaas_customer_id`.
5. Dados de cartão nunca vão ao banco nem a log. `creditCardHolderInfo` vem do dono (decifrado) ou do formulário "outros", por cobrança.
6. Pix e cartão no mesmo par de componentes. O Pix continua a funcionar para pagador já conhecido.

## Decisões do design (o operador pode mudar)

| # | Decisão | Motivo |
|---|---|---|
| D1 | A cobrança de cartão fica em `pix_charges`, com coluna `billing_type`. Não cria `card_charges`. | Webhook, estorno, comissão de afiliado, NFS-e, superadmin e `refund_shortfall` já leem `pix_charges`. Tabela nova dobraria esses caminhos. O nome da tabela fica legado; um comentário na migration explica. |
| D2 | As duas recargas reservam a linha antes do Asaas (padrão de `reserveClientPixCharge`). A recarga do Bureau deixa de criar a cobrança antes da linha. | O crédito único do cartão e a idempotência pedem a linha antes. O teto de pendentes do Bureau deixa de ser "brando". |
| D3 | A chave de idempotência gerada no navegador é a `external_reference` da linha (uuid, já `unique`). | Reenvio da mesma chave acha a linha e não chama o Asaas de novo. |
| D4 | Dados do dono: tabela nova `payer_profiles`, uma linha por dono (cliente ou Bureau). | O dono de uma carteira de cliente é o cliente; o dono da carteira do Bureau é o Bureau (empresa). |
| D5 | Um blob cifrado por linha (JSON com documento, CEP e número), não uma coluna cifrada por campo. | Um IV, uma tag, uma escrita atômica. |
| D6 | Formas mascaradas ficam em colunas em claro, geradas na escrita, com `check` de formato no banco. | A tela mostra o dado conhecido sem decifrar. O `check` impede documento completo na coluna mascarada. |
| D7 | Decifrar só acontece no caminho da cobrança (criar ou atualizar o cliente Asaas, montar `creditCardHolderInfo`). | A tela e a exportação nunca precisam do valor completo. |
| D8 | Dono cliente sem `payer_profiles`: o servidor usa o Titular próprio do cliente (`holders` com `client_profile_id`) como dado conhecido (documento, CEP, número). Na primeira cobrança, copia esses dados cifrados para `payer_profiles`. | Requisito "pedir só o que falta". O cliente já informou o CPF no cadastro (`register_client`). |
| D9 | Pagador "outros": nada vai para `payer_profiles`. A cobrança guarda só `payer_kind = 'other'`, o documento mascarado e o `asaas_customer_id`. | Requisito 3. |
| D10 | Busca de cliente Asaas por `cpfCnpj` antes de criar, nos dois tipos de pagador. Cliente achado que não criamos para aquele dono é reaproveitado sem atualização. | Evita duplicar clientes. Impede que alguém troque e-mail ou endereço do cliente Asaas de outra pessoa digitando o CPF dela. |
| D11 | `notificationDisabled: true` ao criar cliente Asaas. | A plataforma tem notificações próprias. Evita e-mail do Asaas a terceiros. Confirmar o efeito (post-deploy). |
| D12 | Tabela de taxas do cartão em variável `CARD_FEE_TABLE`; vazia = cartão desligado (a tela esconde a opção). Parcela mínima em `CARD_MIN_INSTALLMENT_CENTS`. | Configuração, nunca fixa no código. Falha fechada. |
| D13 | CEP e número são obrigatórios no Pix só quando a NFS-e está ligada (`readNfseConfig` não nulo). No cartão, sempre. | O Asaas exige endereço para `creditCardHolderInfo`. A prefeitura pode exigir endereço do tomador. |
| D14 | Máscara do documento no checkout: a do operador. CPF `***.456.***-**`, CNPJ `**.345.***/****-**`. CEP `*****-678`. Número: "informado". Telefone `(**) *****-4321`. E-mail: `maskRecipient` (`src/lib/auth/email.ts`). | Pedido do operador. As outras telas mantêm a máscara atual. |
| D15 | `ASAAS_CUSTOMER_ID` sai de `readAsaasConfig`, `AsaasClientSettings`, testes e `.env.example`. Nenhum uso real sobra: só `createPixCharge` o lia. | Requisito 1. `docker-stack.yml` e o instalador não têm a variável hoje. |
| D16 | A stack e o instalador passam a entregar as variáveis do Asaas, da NFS-e, do cartão e a chave PII. Hoje `docker-stack.yml` não passa nenhuma variável `ASAAS_*` ao `reino_app`: em produção `readAsaasConfig` falha e a recarga não funciona. | Sem isso o recurso não roda em produção. |

## Modelo de dados

### Tabela `payer_profiles` (migration 040)

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | uuid pk | |
| `bureau_id` | uuid not null, fk `bureaus` | Tenant. |
| `client_profile_id` | uuid null | Preenchido = dono é o cliente. Nulo = dono é o Bureau. FK composta `(bureau_id, client_profile_id)` para `client_wallets`, como `pix_charges`. |
| `name` | text null | Nome do pagador (dono Bureau: razão social). Nulo = usar o perfil. |
| `email` | text null | Nulo = e-mail da conta. |
| `phone_e164` | text null, `check` E.164 | Nulo = `profiles.phone_e164`. |
| `pii_ciphertext` | bytea not null | Blob cifrado (formato abaixo). |
| `pii_key_id` | text not null, `check ~ '^[a-z0-9_-]{1,32}$'` | Id da chave que cifrou. |
| `document_masked` | text null, `check` de formato (só as máscaras de D14) | |
| `postal_code_masked` | text null, `check ~ '^\*{5}-\d{3}$'` | |
| `has_address_number` | boolean not null default false | |
| `asaas_customer_id` | text null, `check` não vazio, até 100 caracteres | Cliente Asaas criado ou adotado para este dono. |
| `asaas_customer_owned` | boolean not null default false | true = nós criamos o cliente para este dono (pode atualizar). |
| `asaas_customer_stale` | boolean not null default false | true = dado mudou depois da última sincronização. |
| `created_at`, `updated_at` | timestamptz | |

Índices únicos: `(client_profile_id) where client_profile_id is not null` e `(bureau_id) where client_profile_id is null`.

### Colunas novas em `pix_charges` (migration 040)

| Coluna | Tipo | Regra |
|---|---|---|
| `billing_type` | text not null default `'PIX'`, `check in ('PIX','CREDIT_CARD')` | |
| `installments` | smallint not null default 1, `check between 1 and 12` | `> 1` só com `CREDIT_CARD`. |
| `fee_amount` | numeric(15,2) not null default 0, `check >= 0` | Taxa repassada. 0 no Pix. |
| `total_charged` | numeric(15,2) null | Valor cobrado do pagador. Nulo no Pix (= `amount`). `amount` continua sendo o valor creditado. |
| `asaas_installment_id` | text null, unique parcial | Id do parcelamento. |
| `card_brand` | text null, até 20 caracteres | |
| `card_last4` | text null, `check ~ '^\d{4}$'` | |
| `asaas_customer_id` | text null | Cliente Asaas da cobrança. Nulo só em linhas antigas. |
| `payer_kind` | text null, `check in ('owner','other')` | Nulo só em linhas antigas. |
| `payer_document_masked` | text null, mesmo `check` de `document_masked` | Para recibo e conciliação. |

O `check` atual de `amount` (10 a 5000) continua: vale para a recarga, não para o total.

### Cifra

- Algoritmo: AES-256-GCM, `node:crypto`. Sem dependência nova.
- Blob: `0x01` (versão) + IV de 12 bytes aleatórios + tag de 16 bytes + texto cifrado do JSON `{ document, postalCode, addressNumber }` (campos ausentes = omitidos).
- AAD: `payer:<bureau_id>:<client_profile_id ou "bureau">`. Um blob copiado para outra linha não decifra.
- Anel de chaves: variável `PII_ENCRYPTION_KEY` (ou `PII_ENCRYPTION_KEY_FILE`, lida por `hydrateSecretEnv`) no formato `id:base64,id:base64`. A primeira chave cifra. Todas decifram. Cada chave tem 32 bytes. Erro de formato nunca mostra o valor.
- Rotação:
  1. Criar o secret `pii_encryption_key_v2` com `k2:<nova>,k1:<antiga>`.
  2. Trocar `source` do secret na stack (`target: pii_encryption_key`). Docker secret é imutável.
  3. Toda leitura com chave antiga no caminho da cobrança recifra com a chave ativa na mesma transação.
  4. Manter a chave antiga até `select pii_key_id, count(*) from payer_profiles group by 1` mostrar só a nova. Recifrar linhas paradas pede script; fica fora deste escopo.
- Perda da chave: o blob fica ilegível. Efeito: o dono digita os dados de novo. A cobrança e o saldo não dependem do blob. O backup do banco leva o blob, nunca a chave. O instalador grava a chave no arquivo de credenciais "GUARDAR".

### O que cada um vê

| Quem | `payer_profiles` do cliente | `payer_profiles` do Bureau | `pix_charges.payer_*` |
|---|---|---|---|
| Cliente dono | Lê e grava a própria linha. Tela só com máscara. | Nada. | Só as próprias cobranças, como hoje. |
| `bureau_admin` | Nada (RLS: zero linhas). | Lê e grava a do próprio Bureau. Tela só com máscara. | Cobranças do Bureau, como hoje (mascarado). |
| `operator` | Nada. | Nada, salvo se tiver `wallet:topup`. | Como hoje. |
| Superadmin e sessão de suporte | Nada. Política recusa quando `app.support_session_id` não está vazio. | Nada. | Como hoje. |
| `app_webhook`, `app_dispatch` | Sem grant. | Sem grant. | Como hoje. |
| `backup_reader` | `select` (blob cifrado). | `select`. | Como hoje. |

Regras de exposição por coluna:
- Nenhuma view, função ou exportação lê `pii_ciphertext`, salvo o módulo `src/lib/payers/`.
- `src/lib/payers/` decifra só com a identidade do dono da linha.
- A exportação LGPD (`src/lib/lgpd/export.ts`) leva de `payer_profiles` só `document_masked`, `postal_code_masked`, `has_address_number` e se há cliente Asaas ligado.
- Auditoria: só a forma mascarada e os nomes dos campos alterados. Nunca o valor em claro.

Limite conhecido: `holders.document`, `zip_code` e `address_number` do Titular do cliente já existem em claro e o Bureau os lê no CRM (consultas precisam do documento). Este design não muda `holders`. A regra "o Bureau não lê o CPF completo do cliente" vale para os dados de pagamento. Ver risco R1.

### Funções e RLS (migration 040 e 041)

- `payer_profiles`: RLS `enable` + `force`. Políticas `select`, `insert`, `update` como descrito acima. Sem `delete` para `app_runtime`.
- `lgpd_anonymize_client_account`: nova versão (migration nova, sem editar a 023) apaga a linha de `payer_profiles` do cliente. O cliente Asaas fica no Asaas (prazo fiscal).
- `bind_pix_charge`: nova assinatura `bind_asaas_charge(id, asaas_payment_id, pix_payload, asaas_installment_id, card_brand, card_last4)`. A antiga sai se ficar órfã.
- `apply_asaas_payment` (migration 041, sem editar a 027): ver "Crédito do parcelamento".

## Ciclo do cliente Asaas

Entrada: dados resolvidos do pagador (nome, documento, e-mail, telefone, CEP, número) e, para o dono, a linha de `payer_profiles`.

1. Dono com `asaas_customer_id` e sem `stale`: usar o id. Sem chamada extra.
2. Dono com `asaas_customer_id`, `stale` e `asaas_customer_owned`: `POST /v3/customers/{id}` com os dados atuais, depois `stale = false`. Se `owned = false`: não atualizar; usar o id.
3. Dono sem `asaas_customer_id` (ou documento mudou: a escrita do documento zera o id): `GET /v3/customers?cpfCnpj=<dígitos>`. Primeiro cliente não apagado, o mais antigo: adotar com `owned = false`. Nenhum: `POST /v3/customers` com `externalReference = payer_profiles.id` e `notificationDisabled: true`, depois `owned = true`.
4. Gravar com `update ... set asaas_customer_id = $1 where id = $2 and asaas_customer_id is null returning`. Zero linhas = outra requisição ganhou: ler o id vencedor e usá-lo. O cliente criado a mais fica órfão no Asaas (dados corretos, sem efeito no saldo). Log só com o id.
5. Pagador "outros": passo 3 sem `externalReference` e sem gravar em `payer_profiles`. Achado: reaproveitar sem atualizar.

Idempotência e corrida:
- `POST /v3/customers` não é idempotente. Resultado desconhecido (`AsaasOutcomeUnknownError`): a próxima tentativa faz a busca do passo 3 antes de criar, e converge.
- Nenhuma chamada HTTP roda dentro de transação do banco (padrão atual).
- O caminho `GET /v3/customers?cpfCnpj=` leva o CPF na URL. O rótulo de erro é fixo (`"GET /v3/customers"`). Teste prova que nenhum erro nem log leva o documento.
- O resultado da busca (nome, e-mail, endereço de quem já existe no Asaas) nunca sai do servidor. Só o id é usado.

## Fluxo do checkout

1. Valor da recarga (como hoje).
2. Forma: Pix ou Cartão. Cartão só aparece com `CARD_FEE_TABLE` válida.
3. Pergunta (rádio, padrão "dono"): **"Os dados de pagamento são os do dono da conta ou outros?"** Opções: "Do dono da conta" e "De outra pessoa ou empresa".
4. Dono: a tela mostra os dados conhecidos mascarados, cada um com o link "Alterar". Pede só os campos que faltam para a forma escolhida (matriz abaixo). "Alterar" troca a máscara por um campo vazio. O valor novo vai para `payer_profiles` na confirmação.
5. Outros: a tela pede todos os campos da matriz "outros" e a caixa obrigatória "Declaro que estes dados são de quem paga". Nada fica salvo no perfil do dono.
6. Cartão: número, nome impresso, validade, CVV e o seletor de parcelas (total e valor da parcela vêm do servidor).
7. Confirmar: botão travado, chave de idempotência nova por envio.
8. Pix: QR e código, como hoje. Cartão: "processando" com consulta de status a cada 3 s por até 60 s; depois "pagamento em análise; o saldo atualiza sozinho".

Pagador conhecido e completo (dono, Pix): a etapa 4 só mostra as máscaras. O Pix sai com um clique, como hoje.

### Matriz de campos

O = obrigatório; C = obrigatório se faltar no banco (senão mostra a máscara); N = obrigatório se a NFS-e está ligada e falta; — = não pede.

| Campo | Pix, dono | Pix, outros | Cartão, dono | Cartão, outros |
|---|---|---|---|---|
| Nome | C (cliente: perfil; Bureau: `bureaus.name` como sugestão) | O | C | O |
| CPF/CNPJ (dígitos verificadores) | C | O | C | O |
| E-mail | — (e-mail da conta) | O | — (e-mail da conta) | O |
| Telefone | — | O | C | O |
| CEP | N | O | C | O |
| Número do endereço | N | O | C | O |
| Dados do cartão | — | — | O, nunca salvos | O, nunca salvos |
| Declaração "dados de quem paga" | — | O | — | O |

Origem do dado conhecido do dono: `payer_profiles` primeiro. Cliente sem linha: Titular próprio (D8). Telefone do cliente: `payer_profiles.phone_e164`, senão `profiles.phone_e164`. Telefone novo digitado no checkout vai para `payer_profiles.phone_e164`; não muda `profiles.phone_e164` (essa coluna só muda pela verificação de telefone).

## Cartão (regras mantidas do spec de 2026-11-03)

- Até 12x. Total = (recarga + taxa fixa) / (1 − taxa%), arredondado para cima ao centavo. Parcelas iguais; resto na última. O saldo sobe pela recarga.
- O servidor calcula o total. O total vindo do navegador é ignorado.
- Crédito só pelo webhook. Nunca na resposta síncrona.
- Nunca gravar nem logar número, CVV, validade, corpo da requisição ou `creditCardHolderInfo`. No banco só: ids Asaas, bandeira, 4 últimos dígitos, parcelas, taxa, total.
- `remoteIp` vem dos cabeçalhos no servidor, com a mesma regra de proxy confiável (`TRAEFIK_PROXY_CIDR`) do cadastro.
- Recusa (HTTP 400): `CardDeclinedError` com mensagem segura; a linha reservada vira `cancelled` (`cancel_unbound_pix_charge`); nenhum crédito.
- Limite: no máximo `MAX_CARD_ATTEMPTS_PER_HOUR = 5` linhas `CREDIT_CARD` por solicitante por hora, contadas sob o mesmo lock da reserva. O teto de Pix pendentes continua.
- Estorno de qualquer parcela reverte o crédito inteiro uma vez.

### Crédito do parcelamento (migration 041)

`apply_asaas_payment` nova versão:
- Acha a linha por `asaas_payment_id`. Sem linha: por `payload.payment.installment = asaas_installment_id`. Sem linha: por `externalReference` (como hoje).
- `CREDIT_CARD`: credita no primeiro `PAYMENT_CONFIRMED` ou `PAYMENT_RECEIVED` do parcelamento. Eventos seguintes de qualquer parcela: `duplicate`.
- `PAYMENT_REFUNDED` (ou chargeback que o Asaas mande como estorno) de qualquer parcela: reverte o crédito inteiro uma vez, pelo ramo de estorno atual (inclui comissão de afiliado e `refund_shortfall`).
- Caminho Pix inalterado.

## NFS-e

- O Asaas emite a nota para o cliente da cobrança. Com cliente por pagador, o tomador passa a ser quem pagou.
- Valor da nota no cartão: `total_charged` (o que o pagador pagou). No Pix: `amount`. **O contador valida** (soma ao aviso fiscal D3 de `docs/operations/nfse.md`).
- Parcelado: uma nota para o parcelamento inteiro, com o id do parcelamento (`installment` em `POST /v3/invoices`), se a API aceitar. Senão, nota na primeira parcela com o total. Confirmar no sandbox (post-deploy).
- Endereço do tomador: CEP e número vão ao cliente Asaas (D13).
- Cobranças antigas, criadas com `ASAAS_CUSTOMER_ID`, mantêm o cliente antigo. Nova tentativa de nota dessas cobranças sai para "Recargas Rainhas". O runbook registra isso.
- `src/lib/nfse/*` muda só para escolher o valor por `billing_type` e para o parcelamento.

## Segurança e LGPD

| # | Risco | Mitigação |
|---|---|---|
| R1 | `holders` guarda documento, CEP e número do cliente em claro; o Bureau lê no CRM. | Fora deste escopo: o CRM precisa do documento para consultar. `payer_profiles` não aumenta a exposição. Registrar no `docs/operations/lgpd.md`. Pergunta aberta ao operador (não bloqueia). |
| R2 | Vazamento do blob junto com a chave. | Chave só em Docker secret, fora do banco e do backup. `read_only` no container. Nenhum log da chave. Teste de `readPiiKeyring` prova que erro não leva o valor. |
| R3 | CPF em log por URL (`GET /v3/customers?cpfCnpj=`). | Rótulo fixo no `call()`. Teste com spy em `console` e na mensagem do erro. |
| R4 | Troca de dados do cliente Asaas de outra pessoa pelo CPF dela. | D10: só atualiza cliente que nós criamos para aquele dono. |
| R5 | NFS-e emitida para CPF de terceiro sem consentimento ("outros"). | Declaração obrigatória. CPF com dígito verificador. Auditoria com tipo de pagador e documento mascarado. O operador revisa o aviso de privacidade (post-deploy). |
| R6 | Bureau lê dado de pagamento do cliente. | RLS sem política para equipe em linhas de cliente. Teste de integração prova zero linhas. Exportação só com máscara. |
| R7 | Sessão de suporte lê ou grava dado de pagamento. | Política recusa com `app.support_session_id` preenchido. Teste. |
| R8 | Dado de cartão em log, banco ou auditoria. | Regras mantidas. Teste com spy em `console`, auditoria e erro, nas duas actions. |
| R9 | Crédito duplicado em parcelamento ou clique duplo. | D3 e migration 041. Testes de integração. |
| R10 | Perda da chave. | Arquivo de credenciais "GUARDAR". O dono digita de novo. Nenhum saldo depende do blob. |
| R11 | Dado de "outros" retido sem base. | Só a máscara na cobrança (prazo fiscal da tabela de retenção). Nada em `payer_profiles`. |
| R12 | Asaas envia e-mail ou SMS ao pagador. | `notificationDisabled: true`. Confirmar (post-deploy). |

Anonimização da conta do cliente apaga `payer_profiles`. `pix_charges.payer_document_masked` fica (prazo fiscal, só máscara).

## Documentos que mudam

- `AGENTS.md`, regra de auditoria. Texto atual: "Write an audit event in the same transaction as each mutation. Never store a full CPF/CNPJ." Texto novo:
  > Write an audit event in the same transaction as each mutation. Store a full CPF/CNPJ only encrypted at rest, through `src/lib/pii/` (existing CRM columns in `holders` are the documented exception). Never put a full CPF/CNPJ in logs, audit metadata, error messages or exports: use the masked form.
- `PRODUCT.md` linha da auditoria: mesma regra em pt-BR. Seção de pagamento: cartão, parcelas, pergunta do pagador.
- `docs/architecture.md`, tabela "Decisões": linhas para D1, D4/D5 (cifra de aplicação com anel de chaves), D10 e D16.
- `docs/operations/lgpd.md`: `payer_profiles` na tabela de retenção (conta + anonimização apaga), o que a exportação leva, R1, dados de "outros".
- `docs/operations/nfse.md`: tomador por pagador, valor no cartão, parcelado, cobranças antigas, aviso ao contador.
- `docs/operations/payments.md` (novo runbook): chave PII (gerar, guardar, rotacionar, perda), taxas do cartão, recusa, conciliação de cliente órfão.
- `docs/setup.md` e `docs/onboarding.md`: variáveis novas.
- `.env.example`, `.env.local.example`: tira `ASAAS_CUSTOMER_ID`; põe `PII_ENCRYPTION_KEY` (valor de dev público), `CARD_FEE_TABLE`, `CARD_MIN_INSTALLMENT_CENTS`.

## Fora de escopo

- Cifrar `holders` (CRM).
- Cartão salvo, recorrência, débito, mais de 12x, antecipação.
- Tela de perfil para ver ou apagar dados de pagamento (o checkout tem "Alterar"; a anonimização apaga).
- Script de recifragem em lote.
- Reconciliação automática de cartão aprovado sem webhook.

## Critérios de aceite

Cada critério aponta para o teste que o prova (nomes no plano).

- Cobrança Pix e de cartão leva o `customer` do pagador; nenhuma usa cliente fixo.
- Dono com dados completos paga Pix sem digitar nada além do valor.
- Dono com dado faltando vê só os campos que faltam; os conhecidos aparecem mascarados.
- "Outros" não grava nada em `payer_profiles` e reaproveita o cliente Asaas achado pelo CPF.
- `payer_profiles` guarda documento, CEP e número só cifrados; a tela e a auditoria só com máscara.
- `bureau_admin` não lê `payer_profiles` de cliente (zero linhas) nem pela exportação LGPD.
- Cartão à vista e parcelado credita uma vez; estorno de qualquer parcela reverte uma vez.
- Nenhum dado de cartão nem CPF completo em log, auditoria ou erro.
- O app sobe em produção com a chave PII do Docker secret; sem a chave, a recarga falha fechada com erro claro.
- (post-deploy) `GET /v3/customers?cpfCnpj=` devolve o cliente e o filtro de apagados funciona.
- (post-deploy) A conta Asaas aceita cartão direto pela API.
- (post-deploy) Formato real do webhook de parcelamento e o primeiro `PAYMENT_CONFIRMED`.
- (post-deploy) Nota do parcelamento (campo `installment`) e valor aceito pela prefeitura.
- (post-deploy) Taxas e parcela mínima reais da conta.
- (post-deploy) `notificationDisabled` evita e-mail do Asaas ao pagador.
- (post-deploy) A NFS-e de teste mostra nome e CPF/CNPJ do pagador.
- (post-deploy) A chave PII está no gerenciador de senhas da operação.
