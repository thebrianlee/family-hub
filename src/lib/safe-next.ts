// Only a path on this hub: "/today", never "//evil.example", "/\\evil.example",
// "/<tab>/evil.example" or "https://…". Browsers resolve those to other sites,
// so resolve exactly as the browser would and keep the result only if it stays
// on this origin.
export function safeNext(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith("/")) return "/today";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin) return "/today";
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith("/") && !path.startsWith("//") ? path : "/today";
  } catch {
    return "/today";
  }
}
