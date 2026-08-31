import nodemailer from "nodemailer";

import { config } from "@/lib/config";

type PasswordResetEmail = {
  user: { email: string; name: string };
  url: string;
};

export function maskRecipient(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

export async function sendPasswordResetEmail({
  user,
  url,
}: PasswordResetEmail): Promise<void> {
  const message = await nodemailer
    .createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    })
    .sendMail({
      from: config.smtpFrom,
      to: user.email,
      subject: "Redefina sua senha",
      text: `Use este link para redefinir sua senha: ${url}`,
      html: `<p>Use <a href="${url}">este link</a> para redefinir sua senha.</p>`,
    });

  console.info("Password reset email sent", {
    messageId: message.messageId,
    recipient: maskRecipient(user.email),
  });
}
