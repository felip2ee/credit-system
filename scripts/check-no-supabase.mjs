// Build-time proof that production source no longer uses Supabase.
// Scans <root>/src for Supabase imports / env vars / query-chain calls.
// Allowed: docs/legacy/**, scripts/migration/** (Task 14 cutover tooling).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PATTERNS = [
  [/@supabase\//, '@supabase/ import'],
  [/NEXT_PUBLIC_SUPABASE_/, 'NEXT_PUBLIC_SUPABASE_ env var'],
  [/SUPABASE_SERVICE_ROLE/, 'SUPABASE_SERVICE_ROLE env var'],
  [/from\s+['"](@\/lib\/supabase|(\.\.?\/)+lib\/supabase|lib\/supabase)/, 'import from lib/supabase'],
  [/\b(createClient|createServiceClient|createAdminClient)\b[\s\S]{0,80}supabase/i, 'supabase client factory'],
  [/(?<!Buffer)\.(from|rpc)\s*\(\s*['"`]/, 'Supabase-style .from()/.rpc() call'],
];

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function scan(root) {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) return [];
  const hits = [];
  for (const file of walk(srcDir)) {
    const dot = file.lastIndexOf('.');
    if (!CODE_EXT.has(file.slice(dot))) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const hit = PATTERNS.find(([re]) => re.test(lines[i]));
      if (hit) {
        hits.push({ file: relative(root, file).split(sep).join('/'), line: i + 1, text: lines[i].trim(), why: hit[1] });
        break;
      }
    }
  }
  return hits;
}

// ponytail: `src` is the only scanned root; docs/legacy + scripts/migration are simply never walked.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-no-supabase.mjs')) {
  const hits = scan(process.cwd());
  if (hits.length === 0) {
    console.log('OK: no Supabase runtime references under src/');
    process.exit(0);
  }
  console.error(`FAIL: ${hits.length} file(s) still reference Supabase under src/:\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.why}]\n    ${h.text}`);
  process.exit(1);
}
