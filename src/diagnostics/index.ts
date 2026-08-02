import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApplicationGraphBuilder,
  type GraphDiagnostic,
} from "../application/graph";
import type { ModuleDefinition } from "../modules";
import {
  verifyGeneratedQuerySQL,
  type GeneratedQueryManifest,
} from "../sql/generated-query";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

/** Analisa um módulo sem criar runtime, registrar controllers ou abrir sockets. */
export function diagnoseApplication(
  root: ModuleDefinition,
): readonly GraphDiagnostic[] {
  return new ApplicationGraphBuilder().build(root).diagnostics;
}

export type DoctorReport = Readonly<{
  readonly schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly diagnostics: readonly GraphDiagnostic[];
}>;

const SENSITIVE_ASSIGNMENT =
  /((?:password|passwd|secret|token|api[_-]?key|database[_-]?url|authorization)\s*[=:]\s*)(["']?)([^\s,"']+)\2/gi;
const URL_CREDENTIALS =
  /((?:postgres(?:ql)?|mysql|redis):\/\/[^\s:@/]+:)[^\s@]+(@)/gi;

function maskSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, "$1$2***$2")
    .replace(URL_CREDENTIALS, "$1***$2")
    .replaceAll(process.cwd(), "<project>")
    .replaceAll(os.tmpdir(), "<tmp>")
    .replaceAll("/dev/shm", "<tmp>")
    .replaceAll(os.homedir(), "<home>");
}

function sanitizeDiagnostic(diagnostic: GraphDiagnostic): GraphDiagnostic {
  return {
    ...diagnostic,
    message: maskSensitiveText(diagnostic.message),
    source: diagnostic.source
      ? {
          ...diagnostic.source,
          file: maskSensitiveText(diagnostic.source.file),
        }
      : undefined,
    related: diagnostic.related?.map((location) => ({
      ...location,
      file: maskSensitiveText(location.file),
    })),
    found: diagnostic.found?.map(maskSensitiveText),
    hint: diagnostic.hint ? maskSensitiveText(diagnostic.hint) : undefined,
  };
}

export function createDoctorReport(
  diagnostics: readonly GraphDiagnostic[],
  strict = false,
): DoctorReport {
  const hasBlockingDiagnostic = diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" ||
      (strict && diagnostic.severity === "warning"),
  );
  return Object.freeze({
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    ok: !hasBlockingDiagnostic,
    diagnostics: Object.freeze(diagnostics.map(sanitizeDiagnostic)),
  });
}

export function formatDoctorReport(report: DoctorReport): string {
  if (report.diagnostics.length === 0)
    return "✓ Grafo da aplicação válido. Nenhum diagnóstico encontrado.";

  return report.diagnostics
    .map((diagnostic) => {
      const subjectParts = [
        diagnostic.module,
        diagnostic.subject?.controller,
        diagnostic.subject?.method,
      ].filter((part): part is string => Boolean(part));
      const subject = subjectParts.length
        ? ` (${subjectParts.join(" > ")})`
        : "";
      const lines = [
        `${diagnostic.severity === "error" ? "✖" : "⚠"} [${diagnostic.code}]${subject}`,
        `  ${diagnostic.message}`,
      ];
      if (diagnostic.source) {
        const location = [
          diagnostic.source.file,
          diagnostic.source.line,
          diagnostic.source.column,
        ]
          .filter((part) => part !== undefined)
          .join(":");
        lines.push(`  Origem: ${location}`);
      }
      if (diagnostic.found?.length)
        lines.push(`  Encontrado: ${diagnostic.found.join(", ")}`);
      if (diagnostic.hint) lines.push(`  Sugestão: ${diagnostic.hint}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Verifica se os SQLs fonte ainda correspondem ao manifest gerado. */
export function verifyGeneratedQueryManifest(
  manifest: GeneratedQueryManifest,
  rootDir = process.cwd(),
): readonly GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  if (manifest.version !== 1) {
    diagnostics.push({
      code: "E_QUERY_MANIFEST_VERSION",
      severity: "error",
      message: `Versão de manifest de queries não suportada: ${String(manifest.version)}.`,
      hint: "Gere novamente os query artifacts com a versão atual do Empilha.",
    });
    return diagnostics;
  }
  for (const query of manifest.queries) {
    const sourceMatch = /^(.*):(\d+)$/.exec(query.source);
    if (!sourceMatch) {
      diagnostics.push({
        code: "E_QUERY_SOURCE_INVALID",
        severity: "error",
        message: `A origem da query "${query.id}" é inválida: ${query.source}.`,
        source: { file: query.source },
      });
      continue;
    }
    const sourceFile = path.resolve(rootDir, sourceMatch[1] ?? "");
    const line = Number(sourceMatch[2]);
    let content: string;
    try {
      content = fs.readFileSync(sourceFile, "utf8");
    } catch {
      diagnostics.push({
        code: "E_QUERY_SOURCE_MISSING",
        severity: "error",
        message: `A fonte da query "${query.id}" não foi encontrada: ${query.source}.`,
        source: { file: query.source },
        hint: "Execute o gerador no diretório correto ou regenere os artifacts.",
      });
      continue;
    }
    const lines = content.split(/\r?\n/);
    const header = lines[line - 1]?.trim() ?? "";
    const headerMatch = /^--\s*@query\s+(\w+)(?:\s+(one|many|exec))?\s*$/.exec(
      header,
    );
    if (!headerMatch || headerMatch[1] !== query.id) {
      diagnostics.push({
        code: "E_QUERY_SOURCE_CHANGED",
        severity: "error",
        message: `A origem declarada para a query "${query.id}" não corresponde ao header em ${query.source}.`,
        source: { file: query.source, line },
      });
      continue;
    }
    const nextHeader = lines.findIndex(
      (value, index) =>
        index >= line &&
        /^--\s*@query\s+\w+(?:\s+(?:one|many|exec))?\s*$/.test(value.trim()),
    );
    const sourceSQL = lines
      .slice(line, nextHeader < 0 ? lines.length : nextHeader)
      .join("\n")
      .trim();
    const verification = verifyGeneratedQuerySQL(query, sourceSQL);
    if (!verification.ok)
      diagnostics.push({
        code: "E_QUERY_STALE",
        severity: "error",
        message: `A query "${query.id}" está desatualizada: o SQL em ${query.source} mudou desde a geração.`,
        source: { file: query.source, line },
        hint: `Execute novamente o gerador; hash esperado ${verification.expectedHash}, atual ${verification.actualHash}.`,
      });
  }
  return Object.freeze(diagnostics);
}
