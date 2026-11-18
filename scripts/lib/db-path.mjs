// Which household database file to open. The web app (src/lib/db.ts) and the
// host scripts (scripts/reset-pin.mjs, scripts/start-prod.mjs) all import this
// one module, so they can never open different files.
//
// The project was called Family Hub before it was renamed to Sproutwall.
// Installs from before the rename keep working without any change:
//
//   1. SPROUTWALL_DB, if set.
//   2. FAMILY_HUB_DB, if set (deprecated name, still honoured).
//   3. <data dir>/sproutwall.db, if it exists.
//   4. <data dir>/family-hub.db, if it exists (installs from before the rename).
//   5. Otherwise <data dir>/sproutwall.db, created on first start.
//
// The file is never renamed or moved. Warnings name files, never full paths.

import fs from "node:fs";
import path from "node:path";

export const DB_FILE = "sproutwall.db";
export const LEGACY_DB_FILE = "family-hub.db";

/** Environment variables that name the database file, newest first. */
export const DB_ENV_VARS = ["SPROUTWALL_DB", "FAMILY_HUB_DB"];

/**
 * @param {{ dataDir: string, env?: Record<string, string | undefined>, base?: string }} opts
 *   dataDir: absolute data folder. base: folder that relative env paths are
 *   resolved against (default: the process working directory).
 * @returns {{ file: string, source: "SPROUTWALL_DB" | "FAMILY_HUB_DB" | "existing" | "legacy" | "new", warnings: string[] }}
 */
export function resolveDbPath({ dataDir, env = process.env, base = process.cwd(/* turbopackIgnore: true */) }) {
  const warnings = [];

  for (const name of DB_ENV_VARS) {
    const value = env[name];
    if (!value) continue;
    const file = path.resolve(base, value);
    if (name === "FAMILY_HUB_DB") {
      warnings.push("FAMILY_HUB_DB is deprecated. Rename it to SPROUTWALL_DB; the value stays the same.");
    }
    if (!fs.existsSync(/* turbopackIgnore: true */ file)) {
      const legacy = path.join(path.dirname(file), LEGACY_DB_FILE);
      if (path.basename(file) !== LEGACY_DB_FILE && fs.existsSync(/* turbopackIgnore: true */ legacy)) {
        warnings.push(
          `${name} names ${path.basename(file)}, which does not exist yet, but ${LEGACY_DB_FILE} is in the same folder. ` +
            `A new empty household will be created. If ${LEGACY_DB_FILE} is your household, point ${name} at it or unset ${name}.`
        );
      }
    }
    return { file, source: name, warnings };
  }

  const current = path.join(dataDir, DB_FILE);
  const legacy = path.join(dataDir, LEGACY_DB_FILE);
  const hasCurrent = fs.existsSync(/* turbopackIgnore: true */ current);
  const hasLegacy = fs.existsSync(/* turbopackIgnore: true */ legacy);
  if (hasCurrent && hasLegacy) {
    warnings.push(
      `Both ${DB_FILE} and ${LEGACY_DB_FILE} are in the data folder. Using ${DB_FILE}. ` +
        `If ${LEGACY_DB_FILE} is the household you want, see "Restore" in the README.`
    );
  }
  if (hasCurrent) return { file: current, source: "existing", warnings };
  if (hasLegacy) return { file: legacy, source: "legacy", warnings };
  return { file: current, source: "new", warnings };
}
