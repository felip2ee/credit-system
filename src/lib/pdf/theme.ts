// Escala visual e métricas de página dos PDFs (timbrado Rainha Cred).

export const PDF_COLORS = {
  ink: "#1E2A26",
  muted: "#6B7773",
  green: "#0B7A66",
  goldText: "#8F6B1F",
  goldRule: "#C9A24A",
  rule: "#D6DCD9",
  ruleSoft: "#E6EAE8",
  zebra: "#F8F9F8",
  positive: "#1F7A5A",
  negative: "#B3402F",
} as const;

// Tamanhos em pt.
export const PDF_TYPE = { name: 22, figure: 18, section: 12, body: 10, table: 9, tableHeader: 8.5 } as const;

// A4 em pt. A área segura foi medida no timbrado 1240x1754 (0,48 pt/px): faixa de cima até 22 pt;
// chave até 101 pt de altura na borda direita do conteúdo; medalha até 110 pt de largura, de 761 pt de altura para baixo;
// faixa de baixo a partir de 804 pt.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PADDING_X = 46;
export const PDF_PAGE = {
  width: PAGE_WIDTH,
  height: PAGE_HEIGHT,
  paddingTop: 108,
  paddingBottom: 96,
  paddingX: PADDING_X,
  contentWidth: PAGE_WIDTH - PADDING_X * 2,
} as const;

// Larguras fixas das colunas de tabela, em pt.
export const PDF_COLUMN_WIDTH = { money: 84, percent: 78, number: 56, date: 66, bool: 52, short: 80 } as const;
export const PDF_ROW_HEIGHT = 18;
