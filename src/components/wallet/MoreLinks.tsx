import Link from "next/link";

const CLS =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-5 text-base font-bold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Paginação por cursor na URL: "Ver mais" abre a próxima página; "Voltar ao início" limpa o cursor.
export function MoreLinks({ nextHref, startHref }: { nextHref: string | null; startHref: string | null }) {
  if (!nextHref && !startHref) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {startHref && (
        <Link href={startHref} className={CLS}>
          Voltar ao início
        </Link>
      )}
      {nextHref && (
        <Link href={nextHref} className={CLS}>
          Ver mais
        </Link>
      )}
    </div>
  );
}
