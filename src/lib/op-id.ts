// A random key for one user action (for example one reward redemption), sent
// with the request so the server applies it once even if it arrives twice.
// Safe for client components: no server imports.

export function newOpId(): string {
  // randomUUID exists only in secure contexts (https or localhost). A hub
  // opened over plain http on the home network falls back to getRandomValues,
  // which every context has.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
