import Link from "next/link";

import { cn } from "@/lib/utils";

// Título de seção com link opcional à direita ("Ver tudo").
export function SectionHeader({
  title,
  link,
  className,
}: {
  title: string;
  link?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <h2 className="text-lg font-bold">{title}</h2>
      {link && (
        <Link
          href={link.href}
          className="inline-flex min-h-11 items-center rounded-full px-2 text-base font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {link.label}
        </Link>
      )}
    </div>
  );
}
