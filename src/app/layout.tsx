import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/brand/brand";
import { BRAND_COLORS } from "@/lib/brand/tokens";
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
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased", atkinson.variable)}>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
