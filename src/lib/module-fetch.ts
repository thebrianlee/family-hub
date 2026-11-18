import { isEnabled } from "./modules";
import { safeGet, type SafeGetOptions, type SafeGetter, type SafeResponse } from "./safe-fetch";

// Every request a module makes to the outside (a calendar feed, a book site,
// a cover image, the Ask bridge) starts here. The module's state is read at
// the moment the request would start, not when the work began, so a module
// switched off in the middle of a refresh, a search fallback or a redirect
// chain starts nothing new. A request already on its way is not cancelled.
// Core's weather request does not come through here: core is always on.

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

/** fetch(), for a module's outside request. Rejects with ModuleOffError, without fetching, while the module is off. */
export async function moduleFetch(moduleId: string, url: string, init?: RequestInit): Promise<Response> {
  assertOn(moduleId);
  return fetch(url, init);
}

/**
 * One safe-fetch GET (src/lib/safe-fetch.ts), for a module's outside request.
 * Rejects with ModuleOffError, without fetching, while the module is off.
 * Code that follows redirects calls this once per hop. `get` is safeGet
 * unless a test passes a stand-in.
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
