import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const skip = new Set(["node_modules", ".next", ".git", "data", "photos", "coverage"]);
const textExt = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".md", ".json", ".yml", ".yaml",
  ".svg", ".html", ".sh", ".toml", ".txt", ".example",
]);
// The hashed list of private words (family names and the like) is never
// committed: short words can be recovered from unsalted hashes by trying a
// list of names. Supply it from outside the repo:
//   PII_HASHES       newline-separated sha256 hex digests (e.g. a CI secret)
//   PII_HASHES_FILE  path to a file with one digest per line
//   scripts/pii-hashes.txt, a local file that .gitignore keeps out of git
// Without any of them, only the generic patterns below are checked.
function loadHashes() {
  if (process.env.PII_HASHES) return process.env.PII_HASHES;
  const file = process.env.PII_HASHES_FILE || path.join(root, "scripts/pii-hashes.txt");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
const blocked = new Set(
  loadHashes()
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean),
);
if (blocked.size === 0) console.log("pii check: no hashed word list configured; checking generic patterns only");
const patterns = [
  { name: "home directory", re: /\/Users\// },
  { name: "dropbox", re: /dropbox/i },
  { name: "tailscale", re: /tailscale/i },
  { name: "sync token", re: /SYNC_TOKEN/ },
  { name: "email address", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const hits = [];

function consider(token, file, line) {
  if (blocked.has(digest(token))) {
    hits.push(`${path.relative(root, file)}:${line} matched a blocked term`);
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (name === "package-lock.json" || name === "pii-hashes.txt" || name === "check-pii.mjs") continue;
    const ext = path.extname(name);
    if (ext && !textExt.has(ext) && name !== ".env.example") continue;
    if (stat.size > 1_000_000) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.name === "email address" && line.includes("example")) continue;
        if (pattern.re.test(line)) hits.push(`${path.relative(root, full)}:${index + 1} [${pattern.name}]`);
      }
      const words = line.toLowerCase().match(/[a-z0-9]+/g) || [];
      for (const word of words) consider(word, full, index + 1);
      for (let size = 2; size <= 4; size += 1) {
        for (let i = 0; i + size <= words.length; i += 1) {
          consider(words.slice(i, i + size).join(" "), full, index + 1);
        }
      }
      for (const number of line.match(/-?\d+\.\d+/g) || []) consider(number, full, index + 1);
    });
  }
}

walk(root);
if (hits.length) {
  console.error(hits.slice(0, 40).join("\n"));
  console.error(`${hits.length} blocked term(s)`);
  process.exit(1);
}
console.log("pii check: no matches");
