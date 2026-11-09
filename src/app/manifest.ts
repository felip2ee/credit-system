import type { MetadataRoute } from "next";
import { BRAND_NAME } from "@/lib/brand/brand";
import { APP_COLORS, BRAND_COLORS } from "@/lib/brand/tokens";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    start_url: "/",
    display: "standalone",
    background_color: APP_COLORS.background,
    theme_color: BRAND_COLORS.brand,
    icons: [
      { src: "/brand/rainha-cred/icones/icone-fundo-branco-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/rainha-cred/icones/icone-fundo-branco-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
