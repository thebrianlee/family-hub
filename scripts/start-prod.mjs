import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureSecrets, loadEnvFile } from "./ensure-secrets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(root, ".env"));
// The web server runs with its working directory inside .next/standalone, so
// relative paths from .env (DATA_DIR=./data) must be pinned to the repo root
// before anything is spawned. Otherwise dev and prod open different databases.
for (const key of ["DATA_DIR", "PHOTO_DIR", "FAMILY_HUB_DB"]) {
  const value = process.env[key];
  if (value && !path.isAbsolute(value)) process.env[key] = path.resolve(root, value);
}
if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(root, "data");
ensureSecrets();
if (process.env.REQUIRE_AUTH_FOR_READS !== "1") {
  console.warn(
    "[family-hub] Listening on every network interface with REQUIRE_AUTH_FOR_READS off: anyone who can reach this port can read the household. Set REQUIRE_AUTH_FOR_READS=1 to require the parent PIN on each screen."
  );
}
process.env.NODE_ENV = "production";
process.env.HOSTNAME = "0.0.0.0";

const bridge = spawn(process.execPath, [path.join(root, "bridge/ask-bridge.mjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

const imageServer = path.join(root, "server.js");
const builtServer = path.join(root, ".next/standalone/server.js");
const web = fs.existsSync(imageServer)
  ? spawn(process.execPath, [imageServer], { cwd: root, env: process.env, stdio: "inherit" })
  : spawn(process.execPath, [builtServer], {
      cwd: path.dirname(builtServer),
      env: process.env,
      stdio: "inherit",
    });

function shutdown(code) {
  bridge.kill("SIGTERM");
  web.kill("SIGTERM");
  process.exit(code);
}

web.on("exit", (code) => shutdown(code ?? 0));
bridge.on("exit", (code) => {
  if (code && code !== 0) console.error("Ask the Hub bridge stopped.");
});
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
