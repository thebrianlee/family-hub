#!/usr/bin/env node
// Forgot the parent PIN? Reset it from the machine that runs the hub.
// There is deliberately no way to do this from the web page.
//
//   npm run reset-pin -- 4827                                      (local checkout)
//   docker compose exec family-hub node scripts/reset-pin.mjs 4827  (Docker)
//
// The new PIN replaces the old one, clears the hub-wide keypad lock, and logs
// every screen out (all unlock cookies are tied to the stored PIN). A screen
// that hit its own wrong-try limit waits it out, or restart the hub.

import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { loadEnvFile } from "./ensure-secrets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(root, ".env"));

const BLOCKED = new Set(["1234", "0000", "1111", "1212", "1004", "2000", "2001", "2580", "0852", "123456", "654321", "123123", "112233", "121212"]);

function pinProblem(pin) {
  if (!/^\d{4,8}$/.test(pin)) return "Use 4 to 8 digits.";
  if (BLOCKED.has(pin) || /^(\d)\1+$/.test(pin)) return "That PIN is too easy to guess.";
  const d = [...pin].map(Number);
  const up = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  const down = d.every((v, i) => i === 0 || v === d[i - 1] - 1);
  if (up || down) return "That PIN is a straight sequence.";
  return null;
}

const pin = process.argv[2] ?? "";
const problem = pinProblem(pin);
if (problem) {
  console.error(`reset-pin: ${problem}\nUsage: npm run reset-pin -- <new 4-8 digit PIN>`);
  process.exit(1);
}

const dataDir = path.resolve(root, process.env.DATA_DIR || "data");
const dbPath = process.env.FAMILY_HUB_DB ? path.resolve(root, process.env.FAMILY_HUB_DB) : path.join(dataDir, "family-hub.db");
const db = new Database(dbPath, { fileMustExist: true });

const salt = randomBytes(16).toString("hex");
const hash = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
const put = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);
db.transaction(() => {
  put.run("parent_pin", `${salt}:${hash}`);
  // Every wrong-try counter and hub-wide lock is a "pin_*" key.
  db.prepare("DELETE FROM settings WHERE key LIKE 'pin\\_%' ESCAPE '\\'").run();
})();
db.close();
console.log("Parent PIN reset. Every screen will ask for the new PIN.");
