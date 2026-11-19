import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// scripts/sproutwall is a Python 3 (standard library only) host tool. Its unit
// tests live in scripts/tests; running them here puts them in `npm test`, and
// so in CI, without a separate workflow step.
const root = path.resolve(__dirname, "..");
const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const hasPython = python.status === 0;

if (!hasPython) {
  console.warn("install CLI tests skipped: python3 is not installed (scripts/sproutwall needs Python 3.11+).");
}

describe("install CLI (scripts/sproutwall)", () => {
  it.skipIf(!hasPython)(
    hasPython ? "passes its Python unit tests" : "skipped: python3 is not installed",
    () => {
      const run = spawnSync("python3", ["-m", "unittest", "discover", "-s", "scripts/tests", "-t", "."], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        timeout: 180_000,
      });
      expect(run.status, run.stderr).toBe(0);
    },
    200_000,
  );
});
