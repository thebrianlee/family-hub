import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";

import { isValidSecret, readOrCreateSecretFile } from "../../scripts/secret-file.mjs";
import { dataDir } from "./paths";
import { pinProblem } from "./weak-pin";

type PinRecord = { salt: string; hash: string; updatedAt: string };

export function hashPin(pin: string): PinRecord {
  const problem = pinProblem(pin);
  if (problem) {
    throw new Error(problem);
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash, updatedAt: new Date().toISOString() };
}

export function verifyPin(pin: string, record: PinRecord): boolean {
  const next = scryptSync(pin, record.salt, 32, { N: 16384, r: 8, p: 1 });
  const previous = Buffer.from(record.hash, "hex");
  if (next.length !== previous.length) return false;
  return timingSafeEqual(next, previous);
}

function secretFile(): string {
  return path.join(/* turbopackIgnore: true */ dataDir(), "session-secret");
}

// Same rule and the same file handling as scripts/ensure-secrets.mjs, which
// normally runs first: both use scripts/secret-file.mjs.
const MIN_SECRET = 32;

export function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) {
    if (!isValidSecret(fromEnv, MIN_SECRET)) {
      throw new Error(
        `SESSION_SECRET must be at least ${MIN_SECRET} characters with no spaces, using only printable ASCII. Set a longer value, or remove it to let Sproutwall generate one.`,
      );
    }
    return fromEnv;
  }
  const file = secretFile();
  const value = readOrCreateSecretFile(file);
  if (!isValidSecret(value, MIN_SECRET)) {
    throw new Error(
      `${file} does not hold a valid session secret (needs ${MIN_SECRET}+ characters of printable ASCII, no spaces). Delete it and restart to generate a new one, or set SESSION_SECRET.`,
    );
  }
  return value;
}
