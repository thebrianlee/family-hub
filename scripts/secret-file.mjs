import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Shared by scripts/ensure-secrets.mjs (runs before the app starts) and
// src/lib/auth.ts (the app itself), so both apply the same rules.

/**
 * A usable secret: at least `min` characters of printable ASCII, with no
 * whitespace, NUL or other control characters. Applies to values from the
 * environment and from the secret files alike.
 * @param {unknown} value
 * @param {number} min
 * @returns {boolean}
 */
export function isValidSecret(value, min) {
  return typeof value === "string" && value.length >= min && /^[\x21-\x7e]+$/.test(value);
}

/**
 * The secret stored in `file`, created with a new random value first if the
 * file does not exist. Returns the content without surrounding whitespace;
 * the caller validates it.
 *
 * Creation never exposes a partial file: the whole secret is written to a
 * uniquely named temp file in the same folder (mode 0600) and then published
 * with link(), which fails with EEXIST if another process published first.
 * Either way the temp file is removed and the published file, always
 * complete, is read.
 * @param {string} file
 * @returns {string}
 */
export function readOrCreateSecretFile(file) {
  const existing = readIfPresent(file);
  if (existing !== null) return existing;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      // Some filesystems (exFAT USB drives, some network shares) have no hard
      // links. Fall back to an exclusive copy there: still never overwrites
      // another process's secret, though the copy is not atomic.
      if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS" || code === "EXDEV") {
        fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
  } finally {
    fs.unlinkSync(tmp);
  }
  return fs.readFileSync(file, "utf8").trim();
}

/** @param {string} file @returns {string | null} */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw err;
  }
}
