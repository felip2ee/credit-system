const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// The e2e run seeds known passwords, grants balances and wipes rows: it must never touch a real database.
// Checks the URL host plus ?host= / ?hostaddr= (pg lets them override the URL host), like scripts/db/reset.mjs.
export function assertE2eDatabase(url: string, env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new Error("e2e refuses a non-local database: set E2E_ALLOW_REMOTE_DB=1 only for a disposable environment (never with NODE_ENV=production)");
  }
  if (env.E2E_ALLOW_REMOTE_DB === "1") return;
  const parsed = new URL(url);
  const hosts = [parsed.hostname, parsed.searchParams.get("host"), parsed.searchParams.get("hostaddr")].filter(
    (h): h is string => h !== null && h !== "",
  );
  const isLocal = (h: string) => LOCAL_HOSTS.has(h) || h.startsWith("/");
  if (hosts.length === 0 || !hosts.every(isLocal)) {
    throw new Error("e2e refuses a non-local database: set E2E_ALLOW_REMOTE_DB=1 only for a disposable environment");
  }
}
