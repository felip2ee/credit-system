export function safeRedirectPath(next: string, origin: string): string {
  const target = new URL(next, origin);
  return target.origin === origin ? target.toString() : `${origin}/`;
}
