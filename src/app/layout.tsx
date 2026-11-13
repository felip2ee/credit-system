import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { unstable_noStore as noStore } from "next/cache";
import "./globals.css";
import { cn } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/brand/brand";
import { BRAND_COLORS } from "@/lib/brand/tokens";
import { resolveBrandTheme } from "@/lib/brand/theme";
import { QueryProvider } from "@/components/providers/query-provider";

const atkinson = Atkinson_Hyperlegible({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: { default: BRAND_NAME, template: `%s · ${BRAND_NAME}` },
  description: "Diagnóstico e consultoria de crédito para pessoas e empresas.",
  appleWebApp: { capable: true, title: BRAND_NAME, statusBarStyle: "default" },
  icons: { apple: "/brand/rainha-cred/icones/icone-fundo-branco-180.png" },
};

export const viewport: Viewport = {
  themeColor: BRAND_COLORS.brand,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Lê BRAND_THEME a cada pedido: sem isto o Next fixaria o valor do build (a imagem é construída sem a variável).
  noStore();
  const brandTheme = resolveBrandTheme(process.env.BRAND_THEME);
  return (
    <html lang="pt-BR" data-brand-theme={brandTheme} suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased", atkinson.variable)}>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
