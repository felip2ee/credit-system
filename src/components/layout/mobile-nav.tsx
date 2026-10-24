"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

import { isNavActive, visibleNavItems, type NavItem } from "@/components/layout/nav-items";
import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand/brand";
import type { Permission } from "@/lib/db/permissions";
import { cn } from "@/lib/utils";

// Mesmos itens da sidebar, filtrados por permissão e na mesma ordem.
export function mobileNavItems<T extends NavItem>(items: readonly T[], permissions: readonly Permission[]): T[] {
  return visibleNavItems(items, permissions);
}

interface MobileNavProps {
  items: readonly NavItem[];
  // Itens sem permissão aparecem sempre; passe as do usuário para filtrar os demais.
  permissions?: readonly Permission[];
}

// Gaveta sobre o <dialog> nativo: showModal() prende o foco, fecha com Esc e devolve o foco ao botão.
export function MobileNav({ items, permissions = [] }: MobileNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const visible = mobileNavItems(items, permissions);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Fecha ao navegar.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 min-w-11"
        aria-expanded={open}
        aria-controls="mobile-nav-drawer"
        onClick={() => setOpen(true)}
      >
        <Menu aria-hidden />
        Menu
      </Button>
      <dialog
        id="mobile-nav-drawer"
        ref={ref}
        aria-label={`Menu ${BRAND_NAME}`}
        onClose={() => setOpen(false)}
        // Clique no fundo escurecido chega ao próprio <dialog>.
        onClick={(e) => e.target === ref.current && setOpen(false)}
        className="m-0 mr-auto h-full max-h-none w-72 max-w-[85vw] bg-sidebar p-0 text-sidebar-foreground backdrop:bg-black/50"
      >
        <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
          <span className="text-lg font-bold">{BRAND_NAME}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Fechar menu"
            className="min-h-11 min-w-11 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
        <nav aria-label="Principal" className="space-y-2 p-3">
          {visible.map((item) => {
            const active = isNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-md px-3 py-2 text-base font-bold",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </dialog>
    </>
  );
}
