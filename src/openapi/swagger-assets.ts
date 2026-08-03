import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readSwaggerAsset(file: string): string {
  return readFileSync(require.resolve(`swagger-ui-dist/${file}`), "utf8");
}

let assets:
  | Readonly<{
      readonly css: string;
      readonly bundle: string;
      readonly preset: string;
    }>
  | undefined;

export function getSwaggerUiAssets() {
  return (assets ??= Object.freeze({
    css: readSwaggerAsset("swagger-ui.css"),
    bundle: readSwaggerAsset("swagger-ui-bundle.js"),
    preset: readSwaggerAsset("swagger-ui-standalone-preset.js"),
  }));
}
