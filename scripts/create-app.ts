import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const targetArg = args.find((arg) => !arg.startsWith("--"));
const frameworkArgIndex = args.indexOf("--framework");
const frameworkArg =
  frameworkArgIndex === -1 ? undefined : args[frameworkArgIndex + 1];

if (!targetArg) {
  console.error(
    "Uso: bun create empilha <diretório> [--framework <diretório>]",
  );
  process.exit(1);
}

const frameworkRoot = path.resolve(
  frameworkArg ?? path.join(import.meta.dir, ".."),
);
const templateRoot = path.join(frameworkRoot, "scaffold");
const targetRoot = path.resolve(targetArg);

if (!fs.existsSync(templateRoot))
  throw new Error(`Template não encontrado: ${templateRoot}`);
if (fs.existsSync(targetRoot))
  throw new Error(`O diretório já existe: ${targetRoot}`);

fs.cpSync(templateRoot, targetRoot, {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(templateRoot, source);
    return (
      !relative.startsWith("node_modules") &&
      relative !== "src/queries/query-names.ts" &&
      relative !== ".env"
    );
  },
});

const packageFile = path.join(targetRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
packageJson.name = path.basename(targetRoot);
packageJson.private = true;
delete packageJson.bin;
delete packageJson.publishConfig;
packageJson.dependencies["empilha"] =
  `file:${path.relative(targetRoot, frameworkRoot).replaceAll(path.sep, "/") || "."}`;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`Projeto criado em ${targetRoot}`);
console.log("Próximos passos:");
console.log(`  cd ${path.relative(process.cwd(), targetRoot) || "."}`);
console.log("  bun install");
console.log("  bun run generate:queries");
console.log("  bun run typecheck");
console.log("  bun test");
console.log("  bun run check");
console.log("  bun run dev");
