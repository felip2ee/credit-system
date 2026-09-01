export function safeRedirectPath(next: string, origin: string): string {
  let target: URL;
  try {
    target = new URL(next, origin);
  } catch {
    return `${origin}/`;
  }
  return target.origin === origin ? target.toString() : `${origin}/`;
}
