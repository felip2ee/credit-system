// Monta o e-mail de convite ao Portal do Cliente na identidade visual da
// marca: Eliane Moreira — Rainha do Crédito (verde-esmeralda + dourado).
// O link de ativação leva o titular a definir a própria senha.

// Paleta da marca (letterhead): teal/esmeralda + dourado.
const BRAND = {
  teal: "#0E8C84",
  tealDark: "#0B5F59",
  gold: "#C9A24B",
  ink: "#1f2937",
  muted: "#6b7280",
  bg: "#eef1f0",
} as const;

const BRAND_CONTACT =
  "(63) 9 9234-5615 · contato@rainhadocredito.com · @elianerainhadocredito";

export interface PortalInviteEmailParams {
  clientName: string;
  email: string;
  password: string;
  loginUrl: string;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildPortalInviteEmail(p: PortalInviteEmailParams): BuiltEmail {
  const subject = "Seu acesso ao Portal do Cliente — Rainha do Crédito";

  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:${BRAND.bg};font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:480px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <tr><td style="background:${BRAND.tealDark};text-align:center;padding:26px 24px 22px;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.5px;">Eliane Moreira</div>
            <div style="font-size:11px;letter-spacing:3px;color:${BRAND.gold};margin-top:4px;">RAINHA DO CRÉDITO</div>
          </td></tr>
          <tr><td style="background:${BRAND.teal};color:#ffffff;text-align:center;padding:14px 24px;">
            <div style="font-size:17px;font-weight:700;">Portal do Cliente</div>
          </td></tr>
          <tr><td style="padding:26px 24px;text-align:center;font-size:14px;line-height:1.6;">
            <p style="margin:0 0 8px;">Olá ${escapeHtml(p.clientName)},</p>
            <p style="margin:0 0 22px;">Liberamos seu acesso ao Portal do Cliente. Lá você acompanha o andamento das suas solicitações de crédito e envia os documentos necessários, com segurança.</p>
            <p style="margin:0 0 8px;font-size:13px;color:${BRAND.muted};">Acesse com os dados abaixo:</p>
            <div style="margin:0 auto 8px;max-width:320px;border:2px dashed ${BRAND.teal};border-radius:8px;background:#f4faf9;padding:14px 16px;text-align:left;font-size:13px;">
              <div style="margin-bottom:6px;"><strong>E-mail:</strong> ${escapeHtml(p.email)}</div>
              <div><strong>Senha provisória:</strong> <span style="font-family:'Courier New',monospace;font-weight:700;color:${BRAND.tealDark};">${escapeHtml(p.password)}</span></div>
            </div>
            <p style="margin:0 0 22px;font-size:11px;color:${BRAND.muted};">No primeiro acesso o sistema vai pedir que você crie uma nova senha pessoal.</p>
            <a href="${p.loginUrl}" style="display:inline-block;background:${BRAND.gold};color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.5px;padding:14px 28px;border-radius:6px;">ACESSAR O PORTAL</a>
            <p style="margin:22px 0 0;font-size:12px;color:${BRAND.muted};">Se o botão não funcionar, acesse: <br/><a href="${p.loginUrl}" style="color:${BRAND.tealDark};">${p.loginUrl}</a></p>
            <p style="margin:14px 0 0;font-size:11px;color:${BRAND.muted};">Se você não esperava este acesso, ignore este e-mail.</p>
          </td></tr>
          <tr><td style="background:${BRAND.tealDark};padding:16px 24px;text-align:center;font-size:11px;color:#cfe7e4;">
            Eliane Moreira — Rainha do Crédito<br/>${BRAND_CONTACT}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `Olá ${p.clientName},`,
    "",
    "Liberamos seu acesso ao Portal do Cliente. Lá você acompanha o andamento das suas",
    "solicitações de crédito e envia os documentos necessários.",
    "",
    "Acesse com os dados abaixo:",
    `E-mail: ${p.email}`,
    `Senha provisória: ${p.password}`,
    "",
    "No primeiro acesso o sistema vai pedir que você crie uma nova senha pessoal.",
    "",
    `Acesse o portal em: ${p.loginUrl}`,
    "",
    "Eliane Moreira — Rainha do Crédito",
    BRAND_CONTACT,
  ].join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
