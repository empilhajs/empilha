import fs from "node:fs";
import path from "node:path";
import { compileNamedSQL, hashSQL } from "empilha";

const positional = process.argv
  .slice(2)
  .filter((argument) => argument !== "--artifacts");
const artifactMode = process.argv.includes("--artifacts");
const [
  inputDir,
  outputFile,
  registryName = artifactMode ? "queryArtifacts" : "queryNames",
] = positional;

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
const blockPattern = /^--\s*@query\s+(\w+)(?:\s+(one|many|exec))?\s*$/gm;

type QueryArtifactSource = {
  name: string;
  cardinality: "one" | "many" | "exec";
  source: string;
  sql: string;
  sqlHash: string;
  bindings: Record<string, string>;
};

function inputTypeName(name: string): string {
  return `${name[0]?.toUpperCase() ?? "Q"}${name.slice(1)}Input`;
}

function inputType(bindingType: string): string {
  return ["string", "number", "boolean", "unknown"].includes(bindingType)
    ? bindingType
    : "unknown";
}

const artifacts: QueryArtifactSource[] = [];

for (const file of collectSQLFiles(inputDir)) {
  const content = fs.readFileSync(file, "utf8");
  let match = blockPattern.exec(content);

  while (match !== null) {
    const name = match[1];
    if (!/^[A-Za-z_$][\w$]*$/.test(name))
      throw new Error(`Nome de query inválido: ${name} (${file})`);
    if (names.has(name)) throw new Error(`Nome de query duplicado: ${name}`);
    names.add(name);
    if (artifactMode) {
      const start = match.index + match[0].length;
      const next = blockPattern.exec(content);
      const end = next?.index ?? content.length;
      const sql = content.slice(start, end).trim();
      const line = content.slice(0, match.index).split("\n").length;
      const relativeFile = path
        .relative(process.cwd(), file)
        .split(path.sep)
        .join("/");
      const compiled = compileNamedSQL(sql, { includeTypes: true });
      const bindings = Object.fromEntries(
        compiled.bindings.map((binding) => [
          binding,
          compiled.bindingTypes[binding] ?? "unknown",
        ]),
      );
      artifacts.push({
        name,
        cardinality: (match[2] as QueryArtifactSource["cardinality"]) ?? "many",
        source: `${relativeFile}:${line}`,
        sql,
        sqlHash: hashSQL(sql),
        bindings,
      });
      match = next;
      continue;
    }
    match = blockPattern.exec(content);
  }
}

const output = artifactMode
  ? `// Arquivo gerado. Não edite manualmente.\nimport { createGeneratedQueryManifest, defineGeneratedQuery } from "empilha";\n\n${artifacts
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(
        (artifact) =>
          `export type ${inputTypeName(artifact.name)} = Readonly<{\n${Object.keys(
            artifact.bindings,
          )
            .map(
              (binding) =>
                `  "${binding}": ${inputType(artifact.bindings[binding] ?? "unknown")};`,
            )
            .join("\n")}\n}>;`,
      )
      .join("\n\n")}\n\nexport const ${registryName} = {\n${artifacts
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((artifact) => {
        const serialized = JSON.stringify(
          {
            id: artifact.name,
            source: artifact.source,
            cardinality: artifact.cardinality,
            bindings: artifact.bindings,
            sql: artifact.sql,
            sqlHash: artifact.sqlHash,
          },
          null,
          2,
        ).replace(/\n/g, "\n  ");
        return `  ${artifact.name}: defineGeneratedQuery<never, ${inputTypeName(artifact.name)}>(${serialized}),`;
      })
      .join(
        "\n",
      )}\n} as const;\n\nexport const ${registryName}Manifest = createGeneratedQueryManifest(\n  Object.values(${registryName}),\n);\n`
  : `// Arquivo gerado. Não edite manualmente.\nexport const ${registryName} = {\n${[
      ...names,
    ]
      .sort()
      .map((name) => `  ${name}: "${name}",`)
      .join("\n")}\n} as const\n`;
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, output);
console.log(`Geradas ${names.size} queries em ${outputFile}`);
