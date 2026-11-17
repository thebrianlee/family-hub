import fs from "node:fs";
import path from "node:path";

import { isValidSecret, readOrCreateSecretFile } from "./secret-file.mjs";

export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const MIN_SECRET = 32;

// What a secret must meet (isValidSecret: printable ASCII, no whitespace or
// control characters). SESSION_SECRET follows the same rule the app checks
// (src/lib/auth.ts); BRIDGE_TOKEN keeps the bridge's own 16-character minimum
// (bridge/ask-bridge.mjs). A generated file always has 64 characters.
const MIN_LENGTH = {
  SESSION_SECRET: MIN_SECRET,
  BRIDGE_TOKEN: 16,
};

function ensure(name, filename) {
  const fromEnv = process.env[name];
  const min = MIN_LENGTH[name];
  if (fromEnv) {
    if (isValidSecret(fromEnv, min)) return;
    throw new Error(
      `${name} is set but is not valid (needs ${min}+ characters of printable ASCII, no spaces). Fix it, or remove it to let Family Hub generate one.`
    );
  }
  const dir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const file = path.join(dir, filename);
  const value = readOrCreateSecretFile(file);
  if (!isValidSecret(value, MIN_SECRET)) {
    throw new Error(
      `${file} does not hold a valid secret (needs ${MIN_SECRET}+ characters of printable ASCII, no spaces). Delete it and restart to generate a new one.`
    );
  }
  process.env[name] = value;
}

export function ensureSecrets() {
  if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(process.cwd(), "data");
  ensure("SESSION_SECRET", "session-secret");
  ensure("BRIDGE_TOKEN", "bridge-token");
  process.env.BRIDGE_HOST ||= "127.0.0.1";
  process.env.BRIDGE_PORT ||= "8787";
  process.env.PORT ||= "3847";
}
