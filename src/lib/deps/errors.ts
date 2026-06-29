// Erros tipados da integração deps.com.br.

// HTTP 400 da consulta = autorização SCR pendente (doc §4.2). Sinalizamos de forma
// distinta de um erro genérico para que o fluxo de consulta trate como "pendente"
// (e não como falha), mantendo a query aguardando o aceite do titular.
export class DepsScrPendingError extends Error {
  constructor(message = "Autorização SCR pendente.") {
    super(message);
    this.name = "DepsScrPendingError";
  }
}
