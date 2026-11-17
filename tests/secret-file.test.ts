import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionSecret } from "@/lib/auth";
import { ensureSecrets } from "../scripts/ensure-secrets.mjs";
import { isValidSecret, readOrCreateSecretFile } from "../scripts/secret-file.mjs";

// Fixtures are built at runtime from repeated letters, so the CI secret scan
// never sees anything that looks like a real key.
const SAVED = { ...process.env };
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "familyhub-secretfile-"));
  process.env.DATA_DIR = dir;
  delete process.env.SESSION_SECRET;
  delete process.env.BRIDGE_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

const sessionFile = () => path.join(dir, "session-secret");
const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("publishing a new secret file", () => {
  it("links a complete temp file into place, so no reader ever sees a partial secret", () => {
    const realLink = fs.linkSync;
    const seen: { finalExisted: boolean; tmpContent: string; tmpMode: number }[] = [];
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      seen.push({
        finalExisted: fs.existsSync(to),
        tmpContent: fs.readFileSync(from, "utf8"),
        tmpMode: fs.statSync(from).mode & 0o777,
      });
      realLink(from, to);
    });

    const value = sessionSecret();
    expect(seen).toEqual([{ finalExisted: false, tmpContent: `${value}\n`, tmpMode: 0o600 }]);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(sessionFile()).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it("reads the winner's secret when another process publishes first, and cleans up its own temp file", () => {
    const winner = "w".repeat(64);
    const realLink = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      // The other process links its complete file in between our read and our link.
      fs.writeFileSync(to, `${winner}\n`, { mode: 0o600 });
      realLink(from, to);
    });
    expect(readOrCreateSecretFile(sessionFile())).toBe(winner);
    expect(sessionSecret()).toBe(winner);
    expect(leftovers()).toEqual([]);
  });

  it("does not treat an empty file (what a half-finished exclusive create left behind) as a secret", () => {
    fs.writeFileSync(sessionFile(), "", { mode: 0o600 });
    expect(() => sessionSecret()).toThrow(/does not hold a valid session secret/);
    expect(() => ensureSecrets()).toThrow(/does not hold a valid secret/);
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe("");
  });

  it("gives the start script and the app the same generated secret", () => {
    ensureSecrets();
    const fromScript = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    expect(sessionSecret()).toBe(fromScript);
    expect(process.env.BRIDGE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what counts as a secret", () => {
  const long = "s".repeat(40);
  const badContent: [string, string][] = [
    ["a NUL byte", `${long}\0${long}`],
    ["a control character", `${long}\x01`],
    ["a space inside", `${long} ${long}`],
    ["a tab inside", `${long}\t${long}`],
    ["non-ASCII letters", `${long}é`],
    ["too short", "s".repeat(31)],
  ];

  it.each(badContent)("a file with %s is refused by both the start script and the app", (_label, content) => {
    fs.writeFileSync(sessionFile(), content, { mode: 0o600 });
    expect(() => sessionSecret()).toThrow(/does not hold a valid session secret/);
    expect(() => ensureSecrets()).toThrow(/does not hold a valid secret/);
  });

  // NUL cannot be put in an environment variable at all (Node cuts the value there).
  it.each(badContent.filter(([label]) => label !== "a NUL byte"))(
    "SESSION_SECRET with %s is refused by both",
    (_label, value) => {
      process.env.SESSION_SECRET = value;
      expect(() => sessionSecret()).toThrow(/SESSION_SECRET must be at least 32 characters with no spaces/);
      expect(() => ensureSecrets()).toThrow(/SESSION_SECRET is set but is not valid/);
    }
  );

  it("the validator rejects NUL and accepts printable ASCII", () => {
    expect(isValidSecret(`${long}\0`, 32)).toBe(false);
    expect(isValidSecret(`${"s".repeat(30)}!~`, 32)).toBe(true);
  });

  it("BRIDGE_TOKEN keeps its 16-character minimum and gets the same character rule", () => {
    process.env.SESSION_SECRET = "s".repeat(32);
    process.env.BRIDGE_TOKEN = "t".repeat(16);
    expect(() => ensureSecrets()).not.toThrow();
    for (const bad of ["t".repeat(15), `${"t".repeat(10)} ${"t".repeat(10)}`, `${"t".repeat(20)}\x7f`]) {
      process.env.BRIDGE_TOKEN = bad;
      expect(() => ensureSecrets()).toThrow(/BRIDGE_TOKEN is set but is not valid/);
    }
  });
});
