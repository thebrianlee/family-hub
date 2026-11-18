import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashPin, sessionSecret } from "@/lib/auth";
import { setSetting } from "@/lib/queries";
import { signCookie, verifyCookie } from "@/lib/session";

const ORIGINAL_SECRET = process.env.SESSION_SECRET;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sproutwall-secret-"));
  process.env.DATA_DIR = dir;
  delete process.env.SESSION_SECRET;
});

afterEach(() => {
  process.env.SESSION_SECRET = ORIGINAL_SECRET;
  process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

const secretFile = () => path.join(dir, "session-secret");

describe("SESSION_SECRET from the environment", () => {
  it("is used when it has 32+ characters and no spaces", () => {
    // Built at runtime and low-entropy so the CI secret scan doesn't flag a fixture.
    const value = "s".repeat(32);
    process.env.SESSION_SECRET = value;
    expect(sessionSecret()).toBe(value);
    expect(fs.existsSync(secretFile())).toBe(false);
  });

  it.each([
    ["31 characters", "x".repeat(31)],
    ["16 characters (the old minimum)", "s".repeat(16)],
    ["a space inside", `${"a".repeat(20)} ${"b".repeat(20)}`],
    ["a trailing newline", `${"a".repeat(40)}\n`],
  ])("is refused with %s, with a message that says how to fix it", (_label, value) => {
    process.env.SESSION_SECRET = value;
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET must be at least 32 characters with no spaces/);
    expect(fs.existsSync(secretFile())).toBe(false);
  });
});

describe("generated secret file", () => {
  it("is created once, readable only by the owner, and reused", () => {
    const first = sessionSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(secretFile()).mode & 0o777).toBe(0o600);
    expect(sessionSecret()).toBe(first);
    expect(fs.readFileSync(secretFile(), "utf8").trim()).toBe(first);

    // Cookies signed with it verify.
    const h = hashPin("5938");
    setSetting("parent_pin", `${h.salt}:${h.hash}`);
    expect(verifyCookie(signCookie("device"), "device")).toBe(true);
  });

  it("is read, not overwritten, when another process already wrote a valid one", () => {
    const existing = "k".repeat(48);
    fs.writeFileSync(secretFile(), `${existing}\n`, { mode: 0o600 });
    expect(sessionSecret()).toBe(existing);
    expect(fs.readFileSync(secretFile(), "utf8")).toBe(`${existing}\n`);
  });

  it.each([
    ["empty", ""],
    ["too short", "short-secret"],
    ["spaces inside", "this secret has spaces in it and is long enough"],
  ])("is refused when %s, and the message says how to fix it", (_label, content) => {
    fs.writeFileSync(secretFile(), content, { mode: 0o600 });
    expect(() => sessionSecret()).toThrow(/does not hold a valid session secret .*Delete it and restart/);
    // Left alone for the owner to look at.
    expect(fs.readFileSync(secretFile(), "utf8")).toBe(content);
  });
});
