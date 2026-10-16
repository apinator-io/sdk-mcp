import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  define: { __PKG_VERSION__: JSON.stringify(version) },
  test: {
    coverage: { include: ["src/**/*.ts"], exclude: ["src/cli.ts"] },
  },
});
