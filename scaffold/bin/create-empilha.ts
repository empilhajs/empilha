#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

const targetArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

if (!targetArg) {
  console.error("Uso: bun create empilha <diretório>");
  process.exit(1);
}

const templateRoot = path.resolve(import.meta.dir, "..");
const targetRoot = path.resolve(targetArg);

if (fs.existsSync(targetRoot)) {
  throw new Error(`O diretório já existe: ${targetRoot}`);
}

fs.cpSync(templateRoot, targetRoot, {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(templateRoot, source);
    return (
      !relative.startsWith("node_modules") &&
      !relative.startsWith("bin") &&
      relative !== "bun.lock" &&
      relative !== ".git" &&
      relative !== ".npmrc"
    );
  },
});

const packageFile = path.join(targetRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
packageJson.name = path.basename(targetRoot);
packageJson.private = true;
delete packageJson.bin;
delete packageJson.publishConfig;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`Projeto Empilha criado em ${targetRoot}`);
console.log("Próximos passos:");
console.log(`  cd ${path.relative(process.cwd(), targetRoot) || "."}`);
console.log("  bun install");
console.log("  bun run dev");
