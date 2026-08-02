import type { TSchema } from "@sinclair/typebox";
import { getOrCreateRoute } from "../core/metadata";
import type {
  ParameterMetadata,
  ParameterSource,
  ParameterValidator,
  RouteMetadata,
  IdentityAccess,
} from "../core/types";
import { compileValidator } from "./validation";

type ParameterType = Function | TSchema;

function setParameterValidator(
  route: RouteMetadata,
  parameterIndex: number,
  validator: ParameterValidator,
): void {
  route.validators ??= new Map();
  route.validators.set(parameterIndex, validator);
}

function normalizeParameterName(
  source: "param" | "query" | "header",
  name: string,
): string {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error(
      `O nome do parâmetro de origem "${source}" não pode ser vazio.`,
    );
  }

  return source === "header" ? normalizedName.toLowerCase() : normalizedName;
}

/**
 * Registra um parâmetro de método e, opcionalmente, sua conversão ou validação.
 *
 * Cada posição do método pode receber somente um decorator de origem. A
 * metadata produzida aqui é transformada em getter pelo argument compiler
 * durante o registro da aplicação.
 *
 * @param source - Origem do valor na requisição.
 * @param name - Nome do valor dentro da origem.
 * @param typeOrSchema - Construtor de conversão ou schema TypeBox.
 * @returns Um decorator de parâmetro.
 *
 * @throws {Error} Quando usado no construtor ou quando a posição já possui
 * outro decorator.
 */
function createParameterDecorator(
  source: ParameterSource,
  name?: string,
  typeOrSchema?: ParameterType,
): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) {
      throw new Error(
        `O decorador de origem "${source}" não pode ser usado no construtor.`,
      );
    }

    const route = getOrCreateRoute(target, propertyKey);

    if (source === "auth") {
      route.requiresAuth = true;
    }

    if (
      route.parameters.some((parameter) => parameter.index === parameterIndex)
    ) {
      throw new Error(
        `O parâmetro de índice ${parameterIndex} já possui um decorador.`,
      );
    }

    const parameter: ParameterMetadata = {
      index: parameterIndex,
      source,
      name,
    };

    if (typeof typeOrSchema === "function") {
      parameter.type = typeOrSchema;
    } else if (typeOrSchema) {
      parameter.schema = typeOrSchema;
      setParameterValidator(
        route,
        parameterIndex,
        compileValidator(typeOrSchema),
      );
    }

    route.parameters.push(parameter);
  };
}

/**
 * Injeta um parâmetro capturado no caminho da rota.
 *
 * @param name - Nome usado no caminho, como `id` em `/users/:id`.
 * @param typeOrSchema - Construtor para conversão ou schema para validação.
 * @returns Um decorator de parâmetro.
 *
 * @example
 * get(@Param("id", Number) id: number) {}
 */
export function Param(
  name: string,
  typeOrSchema?: ParameterType,
): ParameterDecorator {
  return createParameterDecorator(
    "param",
    normalizeParameterName("param", name),
    typeOrSchema,
  );
}

/**
 * Injeta um valor da query string.
 *
 * @param name - Nome do parâmetro, como `page` em `?page=2`.
 * @param typeOrSchema - Construtor para conversão ou schema para validação.
 * @returns Um decorator de parâmetro.
 */
export function Query(
  name: string,
  typeOrSchema?: ParameterType,
): ParameterDecorator {
  return createParameterDecorator(
    "query",
    normalizeParameterName("query", name),
    typeOrSchema,
  );
}

/**
 * Injeta um valor dos headers da requisição.
 *
 * O nome é normalizado para letras minúsculas, seguindo o comportamento de
 * `Headers`.
 *
 * @param name - Nome do header que será lido.
 * @param typeOrSchema - Construtor para conversão ou schema para validação.
 * @returns Um decorator de parâmetro.
 */
export function Header(
  name: string,
  typeOrSchema?: ParameterType,
): ParameterDecorator {
  return createParameterDecorator(
    "header",
    normalizeParameterName("header", name),
    typeOrSchema,
  );
}

/**
 * Injeta o objeto completo da requisição.
 *
 * O objeto contém query, headers e body já normalizados pelo pipeline HTTP.
 *
 * @returns Um decorator de parâmetro.
 */
export function Request(): ParameterDecorator {
  return createParameterDecorator("request");
}

/**
 * Injeta o `RequestScope` associado à requisição atual.
 *
 * @returns Um decorator de parâmetro.
 * @throws {Error} Quando executado fora de uma rota contextual.
 */
export function Context(): ParameterDecorator {
  return createParameterDecorator("context");
}

/**
 * Injeta o payload autenticado retornado por `app.auth()`.
 *
 * A presença desse decorator exige um bearer token válido, mas não exige uma
 * role específica.
 *
 * @returns Um decorator de parâmetro.
 *
 * @example
 * profile(@Identity() user: User) {
 *   return user
 * }
 */
export function Identity<TAccess extends IdentityAccess = IdentityAccess>(
  access?: TAccess,
): ParameterDecorator {
  if (access !== undefined && (typeof access !== "object" || access === null)) {
    throw new TypeError("O acesso de identidade precisa ser um descritor.");
  }

  const decorator = createParameterDecorator("auth", undefined, access?.claims);
  return (target, propertyKey, parameterIndex) => {
    decorator(target, propertyKey, parameterIndex);
    if (propertyKey === undefined) return;
    const route = getOrCreateRoute(target, propertyKey);
    route.identity = access?.name;
    route.identitySchema = access?.claims;
  };
}
