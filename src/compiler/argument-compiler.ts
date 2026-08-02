import type {
  ParameterMetadata,
  ParameterValidator,
  RouteMetadata,
  RouteRequest,
} from "../core/types";
import { requestContext } from "../context";
import { ValidationError } from "../errors";
import type { DependencyToken } from "../di";

/**
 * Obtém o valor de um argumento a partir
 * dos dados completos da requisição.
 */
type ArgumentGetter = (request: RouteRequest) => unknown;
type DependencyResolver = (token: DependencyToken) => unknown;

/**
 * Compila os argumentos de uma rota
 * a partir da requisição completa.
 */
type ArgumentCompiler = (request: RouteRequest) => unknown[];

/**
 * Ordena os parâmetros pela posição ocupada
 * na assinatura original do método.
 *
 * @param route - Metadados da rota.
 *
 * @returns Uma cópia ordenada dos parâmetros.
 */
function sortParameters(route: RouteMetadata): ParameterMetadata[] {
  return [...route.parameters].sort(
    (first, second) => first.index - second.index,
  );
}

/**
 * Verifica se todos os parâmetros do método
 * possuem um decorator de origem.
 *
 * Os índices devem começar em zero e permanecer
 * contínuos até o último parâmetro.
 *
 * @param parameters - Parâmetros ordenados da rota.
 * @param route - Metadados da rota.
 *
 * @throws {Error} Quando algum parâmetro não possui
 * um decorator de origem.
 */
function assertContiguousParameters(
  parameters: ParameterMetadata[],
  route: RouteMetadata,
): void {
  for (let index = 0; index < parameters.length; index++) {
    if (parameters[index]?.index !== index) {
      throw new Error(
        `O parâmetro ${index} do método ` +
          `${String(route.propertyKey)} ` +
          "não possui um decorador de origem.",
      );
    }
  }
}

/**
 * Verifica se parâmetros que dependem de uma chave
 * possuem um nome definido.
 *
 * Essa validação é aplicada às origens `param`,
 * `query` e `header`.
 *
 * @param parameter - Metadados do parâmetro.
 * @param route - Metadados da rota.
 *
 * @throws {Error} Quando o parâmetro não possui nome.
 */
function assertParameterName(
  parameter: ParameterMetadata,
  route: RouteMetadata,
): void {
  if (
    parameter.source !== "param" &&
    parameter.source !== "query" &&
    parameter.source !== "header"
  ) {
    return;
  }

  if (!parameter.name) {
    throw new Error(
      `O parâmetro ${parameter.index} do método ` +
        `${String(route.propertyKey)} não possui nome.`,
    );
  }
}

/**
 * Prepara e valida os parâmetros de uma rota.
 *
 * Os parâmetros são ordenados, verificados quanto
 * à continuidade dos índices e validados por origem.
 *
 * @param route - Metadados da rota.
 *
 * @returns Os parâmetros preparados para compilação.
 */
function prepareParameters(route: RouteMetadata): ParameterMetadata[] {
  const parameters = sortParameters(route);

  assertContiguousParameters(parameters, route);

  for (const parameter of parameters) {
    assertParameterName(parameter, route);
  }

  return parameters;
}

/**
 * Converte um valor de acordo com o tipo informado
 * no decorator do parâmetro.
 *
 * Atualmente são suportadas conversões para `Number`
 * e `Boolean`. Outros tipos preservam o valor original.
 *
 * @param value - Valor original do parâmetro.
 * @param type - Construtor usado na conversão.
 *
 * @returns O valor convertido.
 */
function convertParameterValue(
  value: unknown,
  type: Function | undefined,
  path: string,
): unknown {
  if (type === Number) {
    if (value == null) return undefined;
    if (value === "" || Number.isNaN(Number(value))) {
      throw new ValidationError([
        { path, message: "Expected a valid number." },
      ]);
    }
    return Number(value);
  }

  if (type === Boolean) {
    if (value == null) {
      return undefined;
    }

    if (typeof value === "boolean") {
      return value;
    }

    return value === "true" || value === "1" || value === 1;
  }

  return value;
}

/**
 * Lê o valor bruto de um parâmetro na requisição.
 *
 * A origem definida pelo decorator determina qual
 * parte da requisição será acessada.
 *
 * @param request - Dados disponíveis na requisição.
 * @param parameter - Metadados do parâmetro.
 *
 * @returns O valor encontrado na origem configurada.
 */
function readParameterValue(
  request: RouteRequest,
  parameter: ParameterMetadata,
  resolveDependency: DependencyResolver | undefined,
): unknown {
  switch (parameter.source) {
    case "body":
      return request.body;

    case "inject":
      if (!resolveDependency || parameter.token === undefined) {
        throw new Error("Nenhum resolvedor de dependências foi configurado.");
      }
      return resolveDependency(parameter.token);

    case "request":
      return request;

    case "header":
      return request.headers[parameter.name as string];

    case "param":
      return request.params[parameter.name as string];

    case "query":
      return request.query[parameter.name as string];

    case "context":
      return requestContext();

    case "auth":
      return requestContext().user;
  }
}

/**
 * Compila o getter de um argumento da rota.
 *
 * O getter lê o valor da requisição, realiza a conversão
 * configurada e executa o validator associado.
 *
 * @param parameter - Metadados do parâmetro.
 * @param validate - Função opcional de validação.
 *
 * @returns Uma função que obtém o argumento da requisição.
 */
function compileArgumentGetter(
  parameter: ParameterMetadata,
  validate?: ParameterValidator,
  resolveDependency?: DependencyResolver,
): ArgumentGetter {
  return (request) => {
    const rawValue = readParameterValue(request, parameter, resolveDependency);

    const value = convertParameterValue(
      rawValue,
      parameter.type,
      parameter.name ?? String(parameter.index),
    );

    validate?.(value);

    return value;
  };
}

/**
 * Compila os getters de argumentos de uma rota.
 *
 * A função retornada transforma uma requisição
 * no array de argumentos esperado pelo método.
 *
 * @param route - Metadados da rota.
 *
 * @returns Uma função que produz os argumentos
 * na ordem da assinatura do método.
 *
 * @throws {Error} Quando os metadados dos parâmetros
 * estão incompletos ou inválidos.
 */
export function compileArgGetters(
  route: RouteMetadata,
  resolveDependency?: DependencyResolver,
): ArgumentCompiler {
  const parameters = prepareParameters(route);

  const getters = parameters.map((parameter) =>
    compileArgumentGetter(
      parameter,
      route.validators?.get(parameter.index),
      resolveDependency,
    ),
  );

  return (request) => {
    const values = new Array<unknown>(getters.length);

    for (let index = 0; index < getters.length; index++) {
      values[index] = getters[index](request);
    }

    return values;
  };
}
