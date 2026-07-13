// Termo de consentimento SCR (autogestão Reino). Reproduz o termo lavrado no
// fluxo da deps, parametrizado pelo nome do autorizado, a instituição e o
// titular. Usado tanto na página pública quanto no snapshot persistido (prova).

export const SCR_SETTING_KEYS = {
  authorizedName: "scr_authorized_name",
  authorizedDocument: "scr_authorized_document",
  institutionName: "scr_institution_name",
  city: "scr_city",
} as const;

export const SCR_TERM_DEFAULTS = {
  // Nome legal/operação que consulta — vai no termo SCR (documento do Bacen).
  // A marca/identidade visual ("Rainha do Crédito") é só o look do e-mail/página.
  authorizedName: "Eliane Moreira - Ordem Consultoria",
  authorizedDocument: "12.296.230/0001-29", // CNPJ de quem opera
  institutionName: "Fidúcia SCMEPP",
  city: "Criciúma - SC",
} as const;

export interface ScrConsentParams {
  authorizedName: string;
  authorizedDocument?: string; // CNPJ de quem opera (opcional)
  institutionName: string;
  clientName: string;
  document: string; // já formatado (CPF/CNPJ)
  city: string;
  date: string; // dd/mm/aaaa
}

export interface ScrConsentTerm {
  intro: string;
  awarenessIntro: string;
  items: string[]; // alíneas a..e
  location: string; // "CIDADE - UF, dd/mm/aaaa"
  clientName: string;
  document: string;
  fullText: string; // para persistir como prova
}

export function buildScrConsentTerm(p: ScrConsentParams): ScrConsentTerm {
  const authorized = p.authorizedDocument
    ? `${p.authorizedName}, CNPJ ${p.authorizedDocument},`
    : p.authorizedName;

  const intro =
    `Autorizo a ${authorized} a consultar os débitos e responsabilidades ` +
    `decorrentes de operações com características de crédito e as informações e os ` +
    `registros de medidas judiciais que em meu nome e/ou de minha empresa ` +
    `${p.clientName}, CNPJ/CPF ${p.document} que constem ou venham a constar do ` +
    `Sistema de Informações de Crédito (SCR), gerido pelo Banco Central do Brasil - ` +
    `Bacen, ou dos sistemas assemelhados que venham a complementá-lo, sob a ótica da ` +
    `análise de crédito que a ${p.institutionName} entender necessária para ` +
    `embasamento da concessão de crédito ou vínculo comercial.`;

  const awarenessIntro = "Estou ciente de que:";

  const items = [
    "a) o SCR tem por finalidades prover informações ao Banco Central do Brasil, " +
      "para fins de monitoramento do crédito no sistema financeiro e para o exercício " +
      "de suas atividades de fiscalização e propiciar o intercâmbio de informações " +
      "entre instituições financeiras, conforme definido no § 1º do art. 1º da Lei " +
      "Complementar nº 105, de 10 de janeiro de 2001, sobre o montante de " +
      "responsabilidades de clientes em operações de crédito;",
    "b) poderei ter acesso aos dados constantes em meu nome no SCR por meio do " +
      "sistema registrado do Banco Central do Brasil - Bacen;",
    "c) a consulta sobre qualquer informação ao SCR depende de minha prévia " +
      "autorização, que é lavrada por meio desse termo;",
    "d) pelo presente, em observância às disposições da Lei nº 13.709, de 14 de " +
      "agosto de 2018 (“Lei Geral de Proteção de Dados”), autorizo o uso de minhas " +
      "informações pessoais, inclusive dados sensíveis que, quiçá, sejam necessários " +
      `para os fins exclusivos da operação de crédito firmada com a ${p.authorizedName};`,
    `e) A ${p.authorizedName} poderá compartilhar as minhas informações, coletados ` +
      "na forma da alínea anterior, com terceiros envolvidos no processo descrito " +
      "neste documento, quando da análise para a contratação de crédito, como também " +
      "poderá transmitir tais informações a possíveis Cessionários ou Endossatários " +
      "da operação que embasa a análise aqui delineada.",
  ];

  const location = `${p.city}, ${p.date}`;

  const fullText = [
    intro,
    awarenessIntro,
    ...items,
    location,
    `Nome/Razão Social: ${p.clientName}`,
    `CNPJ/CPF: ${p.document}`,
  ].join("\n\n");

  return {
    intro,
    awarenessIntro,
    items,
    location,
    clientName: p.clientName,
    document: p.document,
    fullText,
  };
}
