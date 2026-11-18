import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MODULES, type ModuleManifestV0 } from "@/modules/registry";

// Every internet host the code names must be declared by some module in
// permissions.network, so an undeclared call fails here. The other way round
// too: a declared host must still be in the code. "user-configured" (the
// calendar's iCal links) has no fixed host.

const SRC = path.resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [full] : [];
  });
}

function hostsInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(\(\+)?https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
      // "(+https://…)" is the contact URL inside a User-Agent string, which
      // is sent as text and never contacted.
      if (m[1]) continue;
      const host = m[2].toLowerCase().replace(/\.+$/, "");
      if (!host.includes(".")) continue;
      found.set(host, [...(found.get(host) ?? []), path.relative(SRC, file)]);
    }
  }
  return found;
}

const declared = (MODULES as readonly ModuleManifestV0[]).flatMap((m) =>
  m.permissions.network.filter((n) => n !== "user-configured").map((n) => n.split(" ")[0].toLowerCase())
);

describe("declared network hosts", () => {
  it("finds the hosts the code is known to call (the scan works)", () => {
    const hosts = [...hostsInCode().keys()];
    expect(hosts).toEqual(expect.arrayContaining(["api.open-meteo.com", "openlibrary.org", "127.0.0.1"]));
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
