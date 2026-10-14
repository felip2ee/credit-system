export async function register() {
  // The inline guard lets Next drop the Node-only import from the edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureSuperadmin } = await import("@/lib/auth/bootstrap");
    const outcome = await ensureSuperadmin();
    if (outcome === "created") console.log("superadmin: created");
  }
}
