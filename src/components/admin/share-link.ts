// Funções puras do envio do link de pagamento e da máscara de documento mostrada na tela.
export function buildWhatsappUrl({ bureauName, productName, url }: { bureauName: string; productName: string; url: string }): string {
  const text = `Olá! Segue o link de pagamento da sua consulta (${productName}) no ${bureauName}: ${url}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// Só dígitos entram. CPF: ***.123.456-**. CNPJ: **.***.***/1234-**. Outro tamanho: tudo mascarado.
export function maskDocument(value: string): string {
  const d = value.replace(/\D/g, "");
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `**.***.***/${d.slice(8, 12)}-**`;
  return "***";
}
