import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureSecrets, loadEnvFile } from "./ensure-secrets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.local"));
ensureSecrets();

const bridge = spawn(process.execPath, [path.join(root, "bridge/ask-bridge.mjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

const nextBin = path.join(root, "node_modules/next/dist/bin/next");
const web = spawn(process.execPath, [nextBin, "dev", "-p", process.env.PORT, "-H", "0.0.0.0"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

function shutdown(code) {
  bridge.kill("SIGTERM");
  web.kill("SIGTERM");
  process.exit(code);
}

web.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
