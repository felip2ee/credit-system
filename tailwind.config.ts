import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        heading: ["Georgia", '"Times New Roman"', "serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          hover: "hsl(var(--primary-hover))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        cta: {
          DEFAULT: "hsl(var(--cta))",
          foreground: "hsl(var(--cta-foreground))",
          hover: "hsl(var(--cta-hover))",
        },
        brand: {
          deep: "hsl(var(--brand-deep))",
          gold: "hsl(var(--brand-gold))",
          "gold-light": "hsl(var(--brand-gold-light))",
          cream: "hsl(var(--brand-cream))",
        },
        "money-in": { bg: "hsl(var(--money-in-bg))", fg: "hsl(var(--money-in-fg))" },
        "money-out": { bg: "hsl(var(--money-out-bg))", fg: "hsl(var(--money-out-fg))" },
        "money-void": { bg: "hsl(var(--money-void-bg))", fg: "hsl(var(--money-void-fg))" },
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
        surface: "hsl(var(--surface))",
        ink: "hsl(var(--ink))",
        "brand-soft": {
          DEFAULT: "hsl(var(--brand-soft))",
          foreground: "hsl(var(--brand-soft-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        input: "8px",
        card: "12px",
        hero: "16px",
        modal: "24px",
      },
      boxShadow: {
        sm: "var(--shadow-low)",
        DEFAULT: "var(--shadow-low)",
        md: "var(--shadow-mid)",
        lg: "var(--shadow-high)",
        // Brilho só no CTA principal da tela.
        glow: "var(--shadow-glow)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    // Variante `admin:` aplica a classe só dentro de `.theme-admin` e só de `md` (768 px) para cima, onde o layout
    // mostra a sidebar. Abaixo disso vale a escala base (alvos de toque >= 44 px, e2e/mobile.spec.ts).
    plugin(({ addVariant }) => addVariant("admin", "@media (min-width: 768px) { .theme-admin & }")),
  ],
};
export default config;
