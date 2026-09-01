#!/usr/bin/env node
// Enumerate every legacy Storage object and stream it to disk while hashing.
// One object in flight at a time — a whole bucket is never buffered. A missing
// or unreadable object is a FATAL, recorded error (see storage-errors.json).
//
//   node scripts/migration/copy-storage.mjs <SUPABASE_URL> <SERVICE_KEY> <OUT_DIR>
// or SUPABASE_URL / SUPABASE_SERVICE_KEY / MIGRATION_OUT_DIR env vars.
// MIGRATION_BUCKETS (comma-separated) overrides the default bucket list.

import { copyStorage, requireArg } from "./lib.mjs";

const base = requireArg("SUPABASE_URL", process.argv[2] || process.env.SUPABASE_URL).replace(/\/$/, "");
const key = requireArg("SERVICE_KEY", process.argv[3] || process.env.SUPABASE_SERVICE_KEY);
const outDir = requireArg("OUT_DIR", process.argv[4] || process.env.MIGRATION_OUT_DIR);
const buckets = (process.env.MIGRATION_BUCKETS || "documents,opportunity-documents,batch-files")
  .split(",").map((b) => b.trim()).filter(Boolean);

const headers = { Authorization: `Bearer ${key}`, apikey: key };

async function* listBucket(bucket) {
  // Storage list API is paged; walk it fully.
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 100, offset }),
    });
    if (!res.ok) throw new Error(`list ${bucket}: HTTP ${res.status}`);
    const page = await res.json();
    for (const obj of page) {
      if (obj.id === null) continue; // folder placeholder
      yield { bucket, path: obj.name };
    }
    if (page.length < 100) break;
  }
}

const source = {
  async *listStorageObjects() {
    for (const bucket of buckets) yield* listBucket(bucket);
  },
  openStorageObject: async (bucket, path) => {
    const res = await fetch(`${base}/storage/v1/object/${bucket}/${encodeURI(path)}`, { headers });
    if (!res.ok || !res.body) throw new Error(`download ${bucket}/${path}: HTTP ${res.status}`);
    return res.body; // web ReadableStream — pipeline() accepts it
  },
};

console.log(`copy-storage: ${base} buckets [${buckets.join(", ")}] -> ${outDir}/storage`);
const meta = await copyStorage(source, outDir);
console.log(`copy-storage complete — ${meta.count} object(s) hashed`);
