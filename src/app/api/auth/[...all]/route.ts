import { toNextJsHandler } from "better-auth/next-js";

import { authHandler } from "@/lib/auth/server";

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(authHandler);
