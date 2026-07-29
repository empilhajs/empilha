import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { QueryRegistry } from "./query-registry";

/**
 * Normaliza o conteúdo de um arquivo SQL.
 *
 * Remove o marcador BOM, quando presente, e converte
 * diferentes tipos de quebra de linha para `\n`.
 *
 * @param content - Conteúdo original do arquivo.
 *
 * @returns O conteúdo SQL normalizado.
 */
function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * Valida e registra uma query SQL.
 *
 * Queries vazias não são registradas e geram um aviso
 * indicando o nome e o arquivo de origem.
 *
 * @param name - Nome usado para identificar a query.
 * @param sql - Comando SQL que será registrado.
 * @param file - Arquivo de origem da query.
 */
function registerSQL(
  registry: QueryRegistry,
  name: string,
  sql: string,
  file: string,
): void {
  const normalizedSQL = sql.trim();

  if (!normalizedSQL) {
    console.warn(`Query "${name}" em ${file} está vazia.`);
    return;
  }

  registry.register(name, normalizedSQL);
}

/**
 * Extrai e registra múltiplas queries de um arquivo SQL.
 *
 * Cada query deve começar com um cabeçalho no formato
 * `-- nomeDaQuery`.
 *
 * @param content - Conteúdo normalizado do arquivo SQL.
 * @param file - Caminho do arquivo processado.
 *
 * @example
 * -- findUserById
 * SELECT *
 * FROM users
 * WHERE id = $1;
 *
 * -- deleteUser
 * DELETE FROM users
 * WHERE id = $1;
 */
function parseSQL(
  registry: QueryRegistry,
  content: string,
  file: string,
): void {
  const headers = [...content.matchAll(/^--[ \t]*(\w+)[ \t]*$/gm)];

  for (const [index, header] of headers.entries()) {
    const name = header[1];
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[index + 1]?.index ?? content.length;
    const sql = content.slice(start, end);

    registerSQL(registry, name, sql, file);
  }
}

/**
 * Verifica se o caminho representa um arquivo `.sql`.
 *
 * A extensão é comparada sem diferenciar letras
 * maiúsculas e minúsculas.
 *
 * @param file - Nome ou caminho do arquivo.
 *
 * @returns `true` quando a extensão é `.sql`.
 */
function isSQLFile(file: string): boolean {
  return path.extname(file).toLowerCase() === ".sql";
}

/**
 * Carrega e registra as queries de um arquivo SQL.
 *
 * Arquivos iniciados por um cabeçalho `-- nomeDaQuery`
 * podem conter múltiplas queries. Nos demais arquivos,
 * o nome do arquivo é usado como nome da query.
 *
 * @param file - Caminho do arquivo SQL.
 */
function loadFile(registry: QueryRegistry, file: string): void {
  const content = normalizeContent(readFileSync(file, "utf-8"));

  const firstLine = content.trimStart().split("\n", 1)[0];

  const hasBlocks = /^--[ \t]*\w+[ \t]*$/.test(firstLine);

  if (hasBlocks) {
    parseSQL(registry, content, file);
    return;
  }

  const name = path.basename(file, path.extname(file));

  registerSQL(registry, name, content, file);
}

/**
 * Percorre um diretório recursivamente e retorna
 * todos os arquivos SQL encontrados.
 *
 * As entradas são ordenadas pelo nome para garantir
 * uma ordem de carregamento previsível.
 *
 * @param dir - Diretório que será percorrido.
 *
 * @returns Os caminhos dos arquivos SQL encontrados.
 */
function walkDir(dir: string): string[] {
  const files: string[] = [];

  const entries = readdirSync(dir, {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
      continue;
    }

    if (entry.isFile() && isSQLFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Carrega queries a partir de um arquivo SQL
 * ou de todos os arquivos SQL de um diretório.
 *
 * Quando um diretório é informado, seus subdiretórios
 * também são percorridos.
 *
 * @param input - Caminho do arquivo ou diretório.
 *
 * @throws {Error} Quando o caminho não representa
 * um arquivo SQL nem um diretório.
 *
 * @example
 * loadSQL('./queries', registry)
 * loadSQL('./queries/users.sql', registry)
 */
export function loadSQL(input: string, registry: QueryRegistry): void {
  const resolvedInput = path.resolve(input);
  const stat = statSync(resolvedInput);

  if (stat.isDirectory()) {
    for (const file of walkDir(resolvedInput)) {
      loadFile(registry, file);
    }

    return;
  }

  if (stat.isFile() && isSQLFile(resolvedInput)) {
    loadFile(registry, resolvedInput);
    return;
  }

  throw new Error(
    `O caminho "${resolvedInput}" não é um arquivo SQL ou diretório.`,
  );
}
