"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

// No baseURL: better-auth's browser client resolves against the current
// origin (basePath defaults to /api/auth). A relative "/api/auth" string is
// not a valid `new URL()` input and throws during static prerender / SSR.
export const authClient = createAuthClient({
  plugins: [twoFactorClient({ twoFactorPage: "/mfa/verify" })],
});
