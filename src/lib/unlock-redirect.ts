// Client side: what a mounted screen does when the hub says it is no longer
// unlocked (401). The device cookie expired, or the PIN changed and logged
// every other screen out. Whatever the screen already shows must go, so it
// does a full page load of /unlock, which the root layout renders without any
// household data. A full load, not router.replace: the router may hold pages
// it prefetched while unlocked.

/** The unlock page, with this page as where to come back to. */
export function unlockUrl(pathname: string, search = ""): string {
  const here = pathname.startsWith("/unlock") ? "/today" : `${pathname}${search}`;
  return `/unlock?next=${encodeURIComponent(here)}`;
}

export function goToUnlock(): void {
  window.location.replace(unlockUrl(window.location.pathname, window.location.search));
}
