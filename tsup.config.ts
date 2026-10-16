import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

const shared = {
  format: ["esm" as const],
  target: "node18",
  splitting: false,
  sourcemap: true,
  define: { __PKG_VERSION__: JSON.stringify(version) },
};

export default defineConfig([
  { ...shared, entry: ["src/index.ts"], dts: true },
  { ...shared, entry: ["src/cli.ts"], banner: { js: "#!/usr/bin/env node" } },
]);
