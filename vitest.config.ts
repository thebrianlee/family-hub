import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each file gets its own temp DATA_DIR and database (see tests/setup.ts).
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
  },
});
