import { mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outdir = path.join(rootDir, "dist");
const publicDir = path.join(rootDir, "public");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(publicDir, outdir, { recursive: true });

await esbuild.build({
  absWorkingDir: rootDir,
  bundle: true,
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0")
  },
  entryNames: "[name]",
  entryPoints: {
    approval: "src/approval/index.ts",
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    inpage: "src/inpage/index.ts",
    popup: "src/popup/index.ts"
  },
  format: "esm",
  minify: false,
  outdir,
  platform: "browser",
  sourcemap: true,
  target: ["chrome120", "firefox120"]
});
