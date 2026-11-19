import { isEnabled } from "./modules";
import { safeGet, type SafeGetOptions, type SafeGetter, type SafeResponse } from "./safe-fetch";

// Every request a module makes to the outside (a calendar feed, a book site,
// a cover image, the Ask bridge) starts here. The module's state is read at
// the moment the request would start, not when the work began, so a module
// switched off in the middle of a refresh, a search fallback or a redirect
// chain starts nothing new. A request already on its way is not cancelled.
// Core's weather request does not come through here: core is always on.
//
// Redirects never start a request on their own: moduleFetch follows them
// itself, one checked hop at a time, and safe-fetch never follows them (the
// callers of moduleGet follow them one checked hop at a time too).

/** A module's outside request refused because the module is off. Callers stop: no fallback, no next feed, no next hop. */
export class ModuleOffError extends Error {
  constructor(readonly moduleId: string) {
    super(`module_off: ${moduleId}`);
    this.name = "ModuleOffError";
  }
}

function assertOn(moduleId: string): void {
  if (!isEnabled(moduleId)) throw new ModuleOffError(moduleId);
}

/** Redirects moduleFetch follows itself, at most this many per request. */
export const MODULE_FETCH_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch(), for a module's outside request. Rejects with ModuleOffError,
 * without fetching, while the module is off, and so does every redirect hop.
 *
 * - With `redirect: "error"` (the Ask bridge and the Daily Spark: a redirect
 *   is never expected there) one request is made and fetch refuses any
 *   redirect. `redirect: "manual"` is one request too; the caller gets the
 *   3xx answer.
 * - Otherwise fetch is never left to follow a redirect: each hop is a new
 *   request with `redirect: "manual"`, checked first, up to
 *   MODULE_FETCH_MAX_REDIRECTS hops, never from https down to http, and only
 *   for GET and HEAD (any other method must pass `redirect: "error"`). The
 *   caller's signal, so its timeout or abort, covers every hop. Like fetch,
 *   an Authorization header is not sent on to another origin.
 */
export async function moduleFetch(moduleId: string, url: string, init: RequestInit = {}): Promise<Response> {
  if (init.redirect === "error" || init.redirect === "manual") {
    assertOn(moduleId);
    return fetch(url, init);
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new TypeError(`moduleFetch follows redirects only for GET and HEAD; pass redirect: "error" for ${method}`);
  }
  let current = new URL(url);
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    assertOn(moduleId);
    const res = await fetch(current.toString(), { ...init, headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || location === null) return res;
    // The redirect's own body is not read; let its connection go.
    await res.body?.cancel().catch(() => {});
    if (hop >= MODULE_FETCH_MAX_REDIRECTS) throw new Error("too many redirects");
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("redirect to a bad address");
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") throw new Error("redirect to a non-http address");
    if (current.protocol === "https:" && next.protocol === "http:") throw new Error("redirect from https to http refused");
    if (next.origin !== current.origin && headers.has("authorization")) {
      headers = new Headers(headers);
      headers.delete("authorization");
    }
    current = next;
  }
}

/**
 * One safe-fetch GET (src/lib/safe-fetch.ts), for a module's outside request.
 * Rejects with ModuleOffError, without fetching, while the module is off.
 * safe-fetch never follows a redirect; code that follows them calls this once
 * per hop. `get` is safeGet unless a test passes a stand-in.
 */
export async function moduleGet(
  moduleId: string,
  url: string,
  opts: SafeGetOptions,
  get: SafeGetter = safeGet
): Promise<SafeResponse> {
  assertOn(moduleId);
  return get(url, opts);
}
