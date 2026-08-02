import type { TSchema } from "@sinclair/typebox";

export type GeneratedQueryCardinality = "one" | "many" | "exec";
export type GeneratedQueryInput = Readonly<Record<string, unknown>>;

export type GeneratedQueryOptions<TRow extends TSchema = TSchema> = {
  id: string;
  source: string;
  cardinality: GeneratedQueryCardinality;
  bindings?: Readonly<Record<string, string>>;
  row?: TRow;
  sql?: string;
  sqlHash?: string;
};

export type GeneratedQuery<
  TRow extends TSchema = TSchema,
  TInput extends GeneratedQueryInput = GeneratedQueryInput,
> = Readonly<{
  readonly id: string;
  readonly source: string;
  readonly cardinality: GeneratedQueryCardinality;
  readonly bindings: Readonly<Record<string, string>>;
  readonly row?: TRow;
  readonly sql?: string;
  readonly sqlHash?: string;
  readonly input?: TInput;
  readonly hash: string;
}>;

export function hashSQL(sql: string): string {
  return hashText(sql.trim());
}

function hashText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Cria o artefato runtime produzido pelo gerador de queries. */
export function defineGeneratedQuery<
  TRow extends TSchema = TSchema,
  TInput extends GeneratedQueryInput = GeneratedQueryInput,
>(options: GeneratedQueryOptions<TRow>): GeneratedQuery<TRow, TInput> {
  const id = options.id.trim();
  const source = options.source.trim();
  if (!id) throw new TypeError("O id da query gerada não pode ser vazio.");
  if (!source) throw new TypeError(`A query "${id}" precisa de source.`);
  if (options.sqlHash !== undefined && options.sql === undefined)
    throw new TypeError(
      `A query "${id}" não pode declarar sqlHash sem incluir SQL.`,
    );
  const sqlHash = options.sql === undefined ? undefined : hashSQL(options.sql);
  if (options.sqlHash !== undefined && options.sqlHash !== sqlHash)
    throw new TypeError(
      `O sqlHash da query "${id}" não corresponde ao SQL embutido.`,
    );
  const bindings = Object.freeze({ ...options.bindings });
  const canonical = JSON.stringify({
    id,
    source,
    cardinality: options.cardinality,
    bindings,
    sql: options.sql ?? null,
  });
  return Object.freeze({
    id,
    source,
    cardinality: options.cardinality,
    bindings,
    row: options.row,
    sql: options.sql,
    sqlHash,
    input: undefined as TInput | undefined,
    hash: hashText(canonical),
  });
}

export type GeneratedQueryInputOf<TQuery extends GeneratedQuery> =
  TQuery extends GeneratedQuery<TSchema, infer TInput> ? TInput : never;

export type GeneratedQueryManifestEntry = Readonly<{
  readonly id: string;
  readonly source: string;
  readonly cardinality: GeneratedQueryCardinality;
  readonly sqlHash: string;
}>;

export type GeneratedQueryManifest = Readonly<{
  readonly version: 1;
  readonly queries: readonly GeneratedQueryManifestEntry[];
}>;

/** Cria o manifest estável que acompanha os artifacts gerados. */
export function createGeneratedQueryManifest(
  queries: readonly GeneratedQuery[],
): GeneratedQueryManifest {
  const entries = queries.map((query) => {
    if (!query.sqlHash)
      throw new TypeError(
        `A query "${query.id}" precisa de sqlHash para entrar no manifest.`,
      );
    return Object.freeze({
      id: query.id,
      source: query.source,
      cardinality: query.cardinality,
      sqlHash: query.sqlHash,
    });
  });
  return Object.freeze({
    version: 1 as const,
    queries: Object.freeze(entries),
  });
}

export type GeneratedQueryVerification = Readonly<{
  readonly ok: boolean;
  readonly expectedHash: string;
  readonly actualHash: string;
}>;

/** Compara um artifact com o SQL atual da fonte. */
export function verifyGeneratedQuerySQL(
  query: GeneratedQueryManifestEntry | GeneratedQuery,
  sourceSQL: string,
): GeneratedQueryVerification {
  const actualHash = hashSQL(sourceSQL);
  const expectedHash = query.sqlHash ?? "";
  return Object.freeze({
    ok: expectedHash !== "" && actualHash === expectedHash,
    expectedHash,
    actualHash,
  });
}
