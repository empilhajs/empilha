import fs from "node:fs";
import path from "node:path";

const [, , inputDir, outputFile, registryName = "queryNames"] = process.argv;

if (!inputDir || !outputFile || !/^[A-Za-z_$][\w$]*$/.test(registryName)) {
  console.error(
    "Uso: bun generate-query-types.ts <diretório-sql> <arquivo-de-saída> [nome-do-registro]",
  );
  process.exit(1);
}

function collectSQLFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSQLFiles(file);
      return entry.isFile() && entry.name.endsWith(".sql") ? [file] : [];
    })
    .sort();
}

const names = new Set<string>();
const blockPattern = /^--\s*@query\s+(\w+)\s*$/gm;

for (const file of collectSQLFiles(inputDir)) {
  const content = fs.readFileSync(file, "utf8");
  let match = blockPattern.exec(content);

  while (match !== null) {
    const name = match[1];
    if (!/^[A-Za-z_$][\w$]*$/.test(name))
      throw new Error(`Nome de query inválido: ${name} (${file})`);
    if (names.has(name)) throw new Error(`Nome de query duplicado: ${name}`);
    names.add(name);
    match = blockPattern.exec(content);
  }
}

const output = `// Arquivo gerado. Não edite manualmente.\nexport const ${registryName} = {\n${[
  ...names,
]
  .sort()
  .map((name) => `  ${name}: "${name}",`)
  .join("\n")}\n} as const\n`;
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, output);
console.log(`Geradas ${names.size} queries em ${outputFile}`);
