import Link from "next/link";

const ITEMS = [
  { href: "/superadmin", label: "Bureaus" },
  { href: "/superadmin/products", label: "Produtos" },
  { href: "/superadmin/payouts", label: "Repasses" },
  { href: "/superadmin/nfse", label: "NFS-e" },
  { href: "/superadmin/notifications", label: "Notificações" },
  { href: "/superadmin/settings/prompts", label: "Prompts da IA" },
  { href: "/superadmin/settings/scr", label: "Termo SCR" },
];

export function SuperadminNav() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-6 text-lg font-semibold">
        <span className="h-2.5 w-2.5 rounded-full bg-sidebar-primary" />
        <span>
          Superadmin <span className="text-sidebar-primary">Reino</span>
        </span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="block rounded-md px-3 py-2 text-sm font-medium hover:bg-sidebar-border/40"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
