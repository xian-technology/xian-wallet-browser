import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@xian/client": new URL("../xian-js/packages/client/src/index.ts", import.meta.url)
        .pathname,
      "@xian/provider": new URL(
        "../xian-js/packages/provider/src/index.ts",
        import.meta.url
      ).pathname,
      "@xian/wallet-core": new URL(
        "./packages/wallet-core/src/index.ts",
        import.meta.url
      ).pathname
    }
  },
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/*/src/**/*.test.ts"
    ]
  }
});
