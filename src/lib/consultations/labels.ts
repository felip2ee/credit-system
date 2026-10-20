// Rótulos pt-BR para chaves do payload da DEPS: dicionário primeiro, senão camelCase em frase.

const DICTIONARY: ReadonlyMap<string, string> = new Map([
  ["scr", "SCR"],
  ["cpf", "CPF"],
  ["cnpj", "CNPJ"],
  ["uf", "UF"],
  ["cep", "CEP"],
  ["pep", "PEP"],
  ["descricao", "Descrição"],
  ["prejuizo", "Prejuízo"],
  ["coobrigacao", "Coobrigação"],
  ["limiteCredito", "Limite de crédito"],
  ["creditoLiberar", "Crédito a liberar"],
  ["balanco", "Balanço"],
  ["informacaoConsulta", "Informações da consulta"],
  ["pendenciasRestricoes", "Pendências e restrições"],
  ["acoesJudiciais", "Ações judiciais"],
  ["restricoesCheques", "Restrições de cheques"],
  ["outrosEnderecos", "Outros endereços"],
  ["emails", "E-mails"],
  ["versao", "Versão"],
  ["usuario", "Usuário"],
  ["historicoConsultaId", "ID do histórico de consulta"],
  ["isParcial", "Parcial"],
  ["isGrupo", "Grupo"],
  ["centroCusto", "Centro de custo"],
  ["blocosComErros", "Blocos com erros"],
  ["linkCompartilhamento", "Link de compartilhamento"],
]);

export function labelFor(key: string): string {
  const known = DICTIONARY.get(key);
  if (known) return known;
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
