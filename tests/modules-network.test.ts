import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MODULES, type ModuleManifestV0 } from "@/modules/registry";

// Every internet host the code names must be declared by some module in
// permissions.network, so an undeclared call fails here. The other way round
// too: a declared host must still be in the code. "user-configured" (the
// calendar's iCal links) has no fixed host.
//
// The code names a host in a URL ("https://host/…"), escaped in a regular
// expression (an allowlist such as /^books\.google\.com$/), or as a bare name
// in a string (a host list such as ["books.google.com"]). A regex that also
// allows subdomains (/^([a-z0-9-]+\.)*archive\.org$/) needs "*.archive.org"
// declared, and "archive.org" too when the subdomain part is optional; so does
// a string ".archive.org". The registry is the declaration, so it isn't scanned.

const SRC = path.resolve(__dirname, "../src");
const REGISTRY = path.join("modules", "registry.ts");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [full] : [];
  });
}

// A file name (favicon\\.ico in the proxy's matcher) is not a host.
const FILE_NAME = /\.(ico|png|jpe?g|gif|webp|svg|css|html?|json|[cm]?[jt]sx?|txt|ics|db)$/;

/** The hosts a piece of source text names. */
function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  const add = (name: string) => {
    const host = name.toLowerCase().replace(/\.+$/, "");
    if (host.includes(".") && !FILE_NAME.test(host)) hosts.push(host);
  };
  for (const m of text.matchAll(/(\(\+)?https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
    // "(+https://…)" is the contact URL inside a User-Agent string, which
    // is sent as text and never contacted.
    if (m[1]) continue;
    add(m[2]);
  }
  // Escaped dots: a regex. "\.)*" or "\.)+" just before it is a subdomain group.
  for (const m of text.matchAll(/(\\\.\)([*+?]))?((?:[A-Za-z0-9-]+\\+\.)+[A-Za-z][A-Za-z0-9-]*)/g)) {
    const host = m[3].replace(/\\+\./g, ".");
    if (m[2]) add(`*.${host}`);
    if (m[2] !== "+") add(host);
  }
  // A whole quoted string that is a host name; a leading dot means its subdomains.
  for (const m of text.matchAll(/["'`](\.)?((?:[A-Za-z0-9-]+\.)+[A-Za-z][A-Za-z0-9-]*)["'`]/g)) {
    add(m[1] ? `*.${m[2]}` : m[2]);
  }
  return hosts;
}

function hostsInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    if (rel === REGISTRY) continue;
    for (const host of hostsIn(fs.readFileSync(file, "utf8"))) found.set(host, [...(found.get(host) ?? []), rel]);
  }
  return found;
}

const declared = (MODULES as readonly ModuleManifestV0[]).flatMap((m) =>
  m.permissions.network.filter((n) => n !== "user-configured").map((n) => n.split(" ")[0].toLowerCase())
);

describe("declared network hosts", () => {
  it("finds the hosts the code is known to call (the scan works)", () => {
    const hosts = [...hostsInCode().keys()];
    expect(hosts).toEqual(
      expect.arrayContaining([
        "api.open-meteo.com",
        "openlibrary.org",
        "127.0.0.1",
        // Only in the cover allowlist (src/lib/books.ts COVER_HOSTS), as regexes.
        "books.google.com",
        "books.googleusercontent.com",
        "archive.org",
        "*.archive.org",
      ])
    );
  });

  it("finds a host named only in a regex allowlist or a host list, so an undeclared one fails", () => {
    const sample = [
      "const COVERS = [/^cdn\\.example\\.org$/, /^([a-z0-9-]+\\.)+example\\.net$/];",
      'const MORE = ["img.example.com", ".example.edu"];',
      "fetch(`https://api.example.io/v1?q=${q}`);",
    ].join("\n");
    const found = hostsIn(sample).sort();
    expect(found).toEqual(["*.example.edu", "*.example.net", "api.example.io", "cdn.example.org", "img.example.com"]);
    expect(found.filter((h) => !declared.includes(h))).toEqual(found);
  });

  it("every host in src/ is in some module's permissions.network", () => {
    const undeclared = [...hostsInCode()].filter(([host]) => !declared.includes(host));
    expect(undeclared).toEqual([]);
  });

  it("every declared host is still used in src/", () => {
    const hosts = hostsInCode();
    expect(declared.filter((h) => !hosts.has(h))).toEqual([]);
  });
});
