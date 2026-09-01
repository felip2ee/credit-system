import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { config } from "@/lib/config";
import { pool } from "@/lib/db/pool";

export async function GET() {
  let probe: string | undefined;

  try {
    await pool.query("select 1");
    probe = await mkdtemp(path.join(config.documentRoot, ".ready-"));
    await rm(probe, { recursive: true, force: true });
    probe = undefined;
    return new Response("ready", { status: 200 });
  } catch {
    return new Response("unavailable", { status: 503 });
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true }).catch(() => {});
  }
}
