import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file runs in its own process with a throwaway data folder, so
// tests never touch a real household database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sproutwall-test-"));
process.env.DATA_DIR = dir;
delete process.env.SPROUTWALL_DB;
delete process.env.FAMILY_HUB_DB;
delete process.env.PHOTO_DIR;
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
