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
