import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(__dirname, "tests"),
  timeout: 90_000,
  // Extension messaging and signing share CPU with the workspace's native builds.
  // Keep assertions bounded without treating a busy worker as a failed request.
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    viewport: {
      width: 420,
      height: 780
    }
  }
});
