declare const __PKG_VERSION__: string;

/** Package version, injected from package.json at build time. */
export const VERSION: string = typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev";
