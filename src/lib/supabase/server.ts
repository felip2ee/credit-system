import { createServerClient, type CookieOptions } from "@supabase/ssr";
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { cookies } from "next/headers";

import type { Database } from "@/types/supabase";

// O createServerClient (@supabase/ssr) instancia o cliente com 3 generics
// (SupabaseClient<Database, "public", Database["public"]>) e, nessa forma,
// .insert/.update/.upsert resolvem como `never` — bug de threading dos generics
// na combinação ssr 0.5.2 + supabase-js 2.106. O cliente do supabase-js puro
// (1 generic, SupabaseClient<Database>) tipa as escritas corretamente.
// Centralizamos AQUI a ponte de tipo para o formato correto, de modo que os
// Server Actions usem createClient() com type-safety total e SEM casts repetidos.
export function createClient(): SupabaseClient<Database> {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // chamado de um Server Component — o refresh de sessão fica a cargo do middleware
          }
        },
      },
    }
  ) as unknown as SupabaseClient<Database>;
}

// Client com service-role (ignora RLS) — SOMENTE para gravações server-side
// confiáveis (ex.: resultados de consulta da deps). Nunca expor no client.
// Não usa cookies/sessão. As tabelas query_results_pf/pj não têm política de
// escrita por design (só leitura via RLS); a gravação é feita por aqui.
export function createServiceClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
