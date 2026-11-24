import { pool } from "@/lib/db/pool";

const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

export async function getPublicBureau(
  slug: string,
): Promise<{ name: string; slug: string } | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  const { rows } = await pool.query<{ name: string; slug: string }>(
    "select name, slug from public_bureau_by_slug($1)",
    [slug],
  );
  return rows[0] ?? null;
}

export type PublicCatalogItem = {
  code: string;
  name: string;
  salePrice: string;
  salePricePerPartner: string;
};

export async function getPublicCatalog(slug: string): Promise<PublicCatalogItem[]> {
  if (!SLUG_PATTERN.test(slug)) return [];
  const { rows } = await pool.query<{
    code: string;
    name: string;
    sale_price: string;
    sale_price_per_partner: string;
  }>("select code, name, sale_price, sale_price_per_partner from public_bureau_catalog($1)", [slug]);
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    salePrice: r.sale_price,
    salePricePerPartner: r.sale_price_per_partner,
  }));
}

export type ResolvedBureauSlug =
  | { kind: "bureau"; bureau: { name: string; slug: string } }
  | { kind: "redirect"; slug: string }
  | { kind: "missing" };

// Slug atual do bureau, ou o slug atual de quem já teve este slug (redirect 308 nas páginas).
export async function resolveBureauSlug(slug: string): Promise<ResolvedBureauSlug> {
  const bureau = await getPublicBureau(slug);
  if (bureau) return { kind: "bureau", bureau };
  if (!SLUG_PATTERN.test(slug)) return { kind: "missing" };
  const { rows } = await pool.query<{ slug: string }>("select slug from public_bureau_slug_redirect($1)", [slug]);
  return rows[0] ? { kind: "redirect", slug: rows[0].slug } : { kind: "missing" };
}
