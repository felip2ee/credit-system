import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from './check-no-supabase.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'nosupa-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const forbidden = {
  'src/a.ts': `import { createClient } from '@supabase/supabase-js';`,
  'src/b.ts': `const u = process.env.NEXT_PUBLIC_SUPABASE_URL;`,
  'src/c.ts': `const k = process.env.SUPABASE_SERVICE_ROLE_KEY;`,
  'src/d.ts': `import { supabase } from '@/lib/supabase/client';`,
  'src/e.ts': `import { createServiceClient } from '../lib/supabase/server';`,
  'src/f.ts': `const { data } = await db.from('users').select('*');`,
  'src/g.ts': `await supabase.rpc('do_thing');`,
};

for (const [f, body] of Object.entries(forbidden)) {
  test(`rejects ${f}`, () => {
    const root = fixture({ [f]: body });
    const hits = scan(root);
    assert.ok(hits.length >= 1, `expected a hit for ${body}`);
    rmSync(root, { recursive: true, force: true });
  });
}

test('allows docs/legacy and scripts/migration', () => {
  const root = fixture({
    'docs/legacy/old.ts': `import { createClient } from '@supabase/supabase-js';`,
    'scripts/migration/pull.mjs': `const { data } = await supabase.from('users').select('*');`,
    'src/clean.ts': `import { getUser } from '@/lib/db/users';`,
  });
  assert.deepEqual(scan(root), []);
  rmSync(root, { recursive: true, force: true });
});
