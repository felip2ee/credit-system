import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/types/supabase";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isLogin = pathname.startsWith("/login");
  const isReset = pathname.startsWith("/reset-password");
  const isUpdatePw = pathname.startsWith("/update-password");
  const isAuthCallback = pathname.startsWith("/auth");
  const isMfa = pathname.startsWith("/mfa");
  // Página pública de autogestão de SCR (titular autoriza por código).
  const isScrAuth = pathname.startsWith("/autorizacao-scr");

  const redirectTo = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    return NextResponse.redirect(url);
  };

  // Sem sessão: só permite rotas públicas.
  if (!user) {
    if (isLogin || isReset || isAuthCallback || isScrAuth) return supabaseResponse;
    return redirectTo("/login");
  }

  // Com sessão: verifica se precisa elevar para aal2 (MFA pendente).
  let needsMfa = false;
  try {
    const { data: aal } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    needsMfa = aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2";
  } catch {
    needsMfa = false;
  }

  const mfaBypass = isMfa || isAuthCallback || isUpdatePw;
  if (needsMfa && !mfaBypass) {
    return redirectTo("/mfa");
  }

  // Primeiro acesso (ex.: cliente do portal com senha padrão): obriga a trocar
  // a senha antes de qualquer outra rota. A flag é limpa em /update-password.
  const mustChangePassword = Boolean(
    user.user_metadata?.must_change_password
  );
  if (mustChangePassword && !isUpdatePw && !isAuthCallback && !isMfa) {
    return redirectTo("/update-password");
  }

  // Sessão completa: não faz sentido ficar em login/reset/mfa.
  if (!needsMfa && (isLogin || isReset || isMfa)) {
    return redirectTo("/");
  }

  return supabaseResponse;
}
