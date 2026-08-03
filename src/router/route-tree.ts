import { normalizeMethod, normalizePath, splitPath } from "./path";
import { createStringRecord, EMPTY_STRING_RECORD } from "../utils/records";
import {
  parseRoutePattern,
  routeHasPattern,
  type PatternSegment,
} from "./route-pattern";

/**
 * Representa qualquer função que pode ser armazenada
 * como handler de uma rota.
 */
type Handler = (...args: never[]) => unknown;

/**
 * Representa uma rota encontrada na árvore.
 */
export type RouteMatch<THandler extends Handler> = {
  handler: THandler;
  params: Record<string, string>;
};

/**
 * Representa o filho dinâmico de um nó.
 *
 * Cada nó pode possuir apenas um segmento parametrizado,
 * como `:id` ou `:userId`.
 */
interface ParamChild<THandler extends Handler> {
  name: string;
  node: RouteNode<THandler>;
}

/**
 * Representa um nó da árvore de rotas.
 *
 * O nó armazena handlers por método HTTP, filhos estáticos
 * e um possível filho parametrizado.
 */
interface RouteNode<THandler extends Handler> {
  handlers: Map<string, THandler>;
  staticChildren: Map<string, RouteNode<THandler>>;
  paramChild: ParamChild<THandler> | null;
}

type PatternRoute<THandler extends Handler> = {
  method: string;
  path: string;
  segments: PatternSegment[];
  handler: THandler;
};

function patternLengthRange(
  segments: PatternSegment[],
): readonly [minimum: number, maximum: number] {
  let minimum = 0;
  for (const segment of segments) {
    if (segment.kind === "wildcard") return [minimum, Number.POSITIVE_INFINITY];
    if (segment.kind !== "param" || !segment.optional) minimum++;
  }
  return [minimum, segments.length];
}

function patternsMayOverlap(
  first: PatternSegment[],
  second: PatternSegment[],
): boolean {
  const [firstMinimum, firstMaximum] = patternLengthRange(first);
  const [secondMinimum, secondMaximum] = patternLengthRange(second);
  if (firstMaximum < secondMinimum || secondMaximum < firstMinimum)
    return false;

  const sharedLength = Math.min(first.length, second.length);
  for (let index = 0; index < sharedLength; index++) {
    const left = first[index];
    const right = second[index];
    if (left.kind === "wildcard" || right.kind === "wildcard") return true;

    // A partir de um opcional pode haver deslocamento de segmentos. Sem um
    // autômato completo, rejeitar conservadoramente evita falso negativo.
    if (
      (left.kind === "param" && left.optional) ||
      (right.kind === "param" && right.optional)
    ) {
      return true;
    }

    if (left.kind === "static" && right.kind === "static") {
      if (left.value !== right.value) return false;
      continue;
    }
    if (left.kind === "static" && right.kind === "param") {
      if (right.expression && !right.expression.test(left.value)) return false;
      continue;
    }
    if (left.kind === "param" && right.kind === "static") {
      if (left.expression && !left.expression.test(right.value)) return false;
    }
  }

  return true;
}

function samePattern(
  first: PatternSegment[],
  second: PatternSegment[],
): boolean {
  if (first.length !== second.length) return false;

  return first.every((left, index) => {
    const right = second[index];
    if (left.kind !== right.kind) return false;
    if (left.kind === "static" && right.kind === "static") {
      return left.value === right.value;
    }
    if (left.kind === "wildcard" && right.kind === "wildcard") {
      return left.name === right.name;
    }
    if (left.kind !== "param" || right.kind !== "param") return false;
    return (
      left.name === right.name &&
      left.optional === right.optional &&
      left.expression?.source === right.expression?.source
    );
  });
}

/**
 * Cria um novo nó vazio para a árvore de rotas.
 *
 * @returns Um nó sem handlers ou filhos registrados.
 */
function createNode<THandler extends Handler>(): RouteNode<THandler> {
  return {
    handlers: new Map(),
    staticChildren: new Map(),
    paramChild: null,
  };
}

/**
 * Cria um objeto seguro para armazenar parâmetros da rota.
 *
 * O objeto não possui protótipo, evitando conflitos com
 * nomes especiais como `__proto__` e `constructor`.
 *
 * @returns Um objeto vazio para os parâmetros encontrados.
 */
/**
 * Normaliza um método HTTP.
 *
 * Remove espaços externos e converte o método
 * para letras maiúsculas.
 *
 * @param method - Método HTTP que será normalizado.
 *
 * @returns O método HTTP normalizado.
 *
 * @throws {Error} Quando o método informado está vazio.
 */
/**
 * Decodifica um segmento recebido na URL.
 *
 * @param segment - Segmento que será decodificado.
 * @param path - Caminho completo usado na mensagem de erro.
 *
 * @returns O segmento decodificado.
 *
 * @throws {Error} Quando o segmento possui codificação inválida.
 */
function decodePathSegment(segment: string, path: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Error(`Segmento "${segment}" inválido no caminho "${path}".`);
  }
}

/**
 * Reconhece segmentos parametrizados como `:id`.
 *
 * O nome deve começar com uma letra ou `_` e pode
 * conter letras, números e `_`.
 */
const paramRegex = /^:([A-Za-z_]\w*)$/;

/**
 * Armazena e localiza rotas organizadas por segmentos.
 *
 * Segmentos estáticos possuem prioridade sobre segmentos
 * parametrizados durante a busca.
 */
export class RouteTree<THandler extends Handler = Handler> {
  /**
   * Nó inicial da árvore.
   */
  private root = createNode<THandler>();

  private patternRoutes: PatternRoute<THandler>[] = [];

  private registeredRoutes: Array<{
    method: string;
    path: string;
    segments: PatternSegment[];
    hasPattern: boolean;
  }> = [];

  /**
   * Índice medido para rotas totalmente estáticas.
   * A árvore continua sendo a fonte de registro e validação.
   */
  private staticHandlers = Object.create(null) as Record<
    string,
    RouteMatch<THandler>
  >;

  private transactionRoutes: Array<{ method: string; path: string }> | null =
    null;

  /** Valida várias inserções sem clonar a árvore atual. */
  assertCanInsert(routes: readonly { method: string; path: string }[]): void {
    for (const route of routes) {
      if (this.find(route.method, route.path) !== null) {
        throw new Error(`Rota já registrada: ${route.method} ${route.path}`);
      }
    }
  }

  /** Inicia uma transação para desfazer inserções parciais sem copiar a árvore. */
  beginTransaction(): void {
    if (this.transactionRoutes !== null) {
      throw new Error("Já existe uma transação de rotas ativa.");
    }
    this.transactionRoutes = [];
  }

  /** Confirma as inserções realizadas na transação atual. */
  commitTransaction(): void {
    this.transactionRoutes = null;
  }

  /** Desfaz as inserções realizadas na transação atual. */
  rollbackTransaction(): void {
    const routes = this.transactionRoutes;
    this.transactionRoutes = null;
    if (!routes) return;

    for (let index = routes.length - 1; index >= 0; index--) {
      this.remove(routes[index].method, routes[index].path);
    }
  }

  /**
   * Registra um handler para um método e caminho.
   *
   * Rotas estruturalmente iguais podem possuir handlers
   * diferentes para cada método HTTP.
   *
   * @param method - Método HTTP da rota.
   * @param path - Caminho da rota.
   * @param handler - Função associada à rota.
   *
   * @throws {Error} Quando um parâmetro está malformado.
   * @throws {Error} Quando há conflito entre nomes de parâmetros.
   * @throws {Error} Quando a rota já está registrada para o método.
   *
   * @example
   * router.insert('GET', '/users/:id', getUser)
   * router.insert('DELETE', '/users/:id', deleteUser)
   */
  insert(method: string, path: string, handler: THandler): void {
    const normalizedMethod = normalizeMethod(method);
    const normalizedPath = normalizePath(path);
    const segments = splitPath(normalizedPath);
    const patternSegments = parseRoutePattern(normalizedPath);

    const hasPattern = routeHasPattern(patternSegments);
    const ambiguous =
      hasPattern || this.patternRoutes.length > 0
        ? this.registeredRoutes.find(
            (route) =>
              route.method === normalizedMethod &&
              (hasPattern || route.hasPattern) &&
              !samePattern(route.segments, patternSegments) &&
              patternsMayOverlap(route.segments, patternSegments),
          )
        : undefined;
    if (ambiguous) {
      throw new Error(
        `Rotas ambíguas: ${normalizedMethod} ${ambiguous.path} e ${normalizedPath}`,
      );
    }
    if (hasPattern) {
      if (
        this.patternRoutes.some(
          (route) =>
            route.method === normalizedMethod &&
            samePattern(route.segments, patternSegments),
        )
      ) {
        throw new Error(
          `Rota duplicada: ${normalizedMethod} ${normalizedPath}`,
        );
      }
      this.patternRoutes.push({
        method: normalizedMethod,
        path: normalizedPath,
        segments: patternSegments,
        handler,
      });
      this.registeredRoutes.push({
        method: normalizedMethod,
        path: normalizedPath,
        segments: patternSegments,
        hasPattern,
      });
      this.transactionRoutes?.push({
        method: normalizedMethod,
        path: normalizedPath,
      });
      return;
    }

    let current = this.root;

    for (const segment of segments) {
      const paramMatch = segment.match(paramRegex);

      if (segment.startsWith(":") && !paramMatch) {
        throw new Error(
          `Parâmetro inválido "${segment}" na rota "${normalizedPath}".`,
        );
      }

      if (paramMatch) {
        const paramName = paramMatch[1];

        if (!current.paramChild) {
          current.paramChild = {
            name: paramName,
            node: createNode<THandler>(),
          };
        } else if (current.paramChild.name !== paramName) {
          throw new Error(
            `Parâmetro conflitante em "${normalizedPath}": ` +
              `esperado ":${current.paramChild.name}", ` +
              `recebido ":${paramName}".`,
          );
        }

        current = current.paramChild.node;
        continue;
      }

      let child = current.staticChildren.get(segment);

      if (!child) {
        child = createNode<THandler>();
        current.staticChildren.set(segment, child);
      }

      current = child;
    }

    if (current.handlers.has(normalizedMethod)) {
      throw new Error(`Rota duplicada: ${normalizedMethod} ${normalizedPath}`);
    }

    current.handlers.set(normalizedMethod, handler);
    this.registeredRoutes.push({
      method: normalizedMethod,
      path: normalizedPath,
      segments: patternSegments,
      hasPattern,
    });

    if (!segments.some((segment) => paramRegex.test(segment))) {
      this.staticHandlers[`${normalizedMethod} ${normalizedPath}`] =
        Object.freeze({
          handler,
          params: EMPTY_STRING_RECORD,
        });
    }

    this.transactionRoutes?.push({
      method: normalizedMethod,
      path: normalizedPath,
    });
  }

  private remove(method: string, path: string): void {
    const normalizedMethod = normalizeMethod(method);
    const normalizedPath = normalizePath(path);
    const segments = splitPath(normalizedPath);
    const patternSegments = parseRoutePattern(normalizedPath);
    const hasPattern = routeHasPattern(patternSegments);
    const registeredIndex = this.registeredRoutes.findIndex(
      (route) =>
        route.method === normalizedMethod && route.path === normalizedPath,
    );
    if (registeredIndex >= 0) this.registeredRoutes.splice(registeredIndex, 1);

    if (hasPattern) {
      const index = this.patternRoutes.findIndex(
        (route) =>
          route.method === normalizedMethod &&
          samePattern(route.segments, patternSegments),
      );
      if (index >= 0) this.patternRoutes.splice(index, 1);
      return;
    }

    const nodes: Array<{ node: RouteNode<THandler>; segment: string }> = [];
    let current = this.root;
    for (const segment of segments) {
      const paramMatch = segment.match(paramRegex);
      const next = paramMatch
        ? current.paramChild?.node
        : current.staticChildren.get(segment);
      if (!next) return;
      nodes.push({ node: current, segment });
      current = next;
    }

    current.handlers.delete(normalizedMethod);
    delete this.staticHandlers[`${normalizedMethod} ${normalizedPath}`];

    for (let index = nodes.length - 1; index >= 0; index--) {
      const parent = nodes[index].node;
      const segment = nodes[index].segment;
      if (
        current.handlers.size ||
        current.staticChildren.size ||
        current.paramChild
      ) {
        break;
      }
      if (segment.match(paramRegex)) parent.paramChild = null;
      else parent.staticChildren.delete(segment);
      current = parent;
    }
  }

  /**
   * Localiza uma rota pelo método e caminho.
   *
   * A busca direta prioriza segmentos estáticos. Quando
   * esse caminho não encontra um handler, uma segunda busca
   * considera as alternativas parametrizadas.
   *
   * @param method - Método HTTP procurado.
   * @param path - Caminho recebido na requisição.
   *
   * @returns O handler e os parâmetros encontrados,
   * ou `null` quando nenhuma rota corresponde.
   *
   * @example
   * router.find('GET', '/users/10')
   *
   * // {
   * //   handler: getUser,
   * //   params: { id: '10' },
   * // }
   */
  find(method: string, path: string): RouteMatch<THandler> | null {
    const normalizedMethod = normalizeMethod(method);
    const normalizedPath = normalizePath(path);

    const staticMatch =
      this.staticHandlers[`${normalizedMethod} ${normalizedPath}`] ??
      (normalizedMethod === "HEAD"
        ? this.staticHandlers[`GET ${normalizedPath}`]
        : undefined);

    if (staticMatch !== undefined) return staticMatch;

    const segments = splitPath(normalizedPath);

    let current = this.root;
    let params: Record<string, string> | null = null;
    let index = 0;

    while (index < segments.length) {
      const segment = segments[index];
      const staticChild = current.staticChildren.get(segment);

      if (staticChild) {
        current = staticChild;
        index++;
        continue;
      }

      const paramChild = current.paramChild;

      if (!paramChild) {
        break;
      }

      params ??= createStringRecord();

      params[paramChild.name] = decodePathSegment(segment, normalizedPath);

      current = paramChild.node;
      index++;
    }

    if (index === segments.length) {
      const handler =
        current.handlers.get(normalizedMethod) ??
        (normalizedMethod === "HEAD" ? current.handlers.get("GET") : undefined);

      if (handler !== undefined) {
        return {
          handler,
          params: params ?? EMPTY_STRING_RECORD,
        };
      }
    }

    type SearchState = {
      node: RouteNode<THandler>;
      segmentIndex: number;
      params: Record<string, string>;
    };

    const stack: SearchState[] = [
      { node: this.root, segmentIndex: 0, params: createStringRecord() },
    ];

    while (stack.length > 0) {
      const state = stack.pop() as SearchState;

      if (state.segmentIndex === segments.length) {
        const handler =
          state.node.handlers.get(normalizedMethod) ??
          (normalizedMethod === "HEAD"
            ? state.node.handlers.get("GET")
            : undefined);

        if (handler !== undefined) {
          return { handler, params: state.params };
        }
        continue;
      }

      const segment = segments[state.segmentIndex];
      const staticChild = state.node.staticChildren.get(segment);

      // Empilha primeiro o ramo parametrizado para preservar a prioridade do
      // ramo estático durante o backtracking.
      const paramChild = state.node.paramChild;
      if (paramChild) {
        const nextParams = Object.assign(createStringRecord(), state.params);
        nextParams[paramChild.name] = decodePathSegment(
          segment,
          normalizedPath,
        );
        stack.push({
          node: paramChild.node,
          segmentIndex: state.segmentIndex + 1,
          params: nextParams,
        });
      }

      if (staticChild) {
        stack.push({
          node: staticChild,
          segmentIndex: state.segmentIndex + 1,
          params: state.params,
        });
      }
    }

    const candidatePatternRoutes =
      normalizedMethod === "HEAD"
        ? [
            ...this.patternRoutes.filter((route) => route.method === "HEAD"),
            ...this.patternRoutes.filter((route) => route.method === "GET"),
          ]
        : this.patternRoutes.filter(
            (route) => route.method === normalizedMethod,
          );
    for (const route of candidatePatternRoutes) {
      const patternParams = createStringRecord();
      let pathIndex = 0;
      let matched = true;

      for (
        let routeIndex = 0;
        routeIndex < route.segments.length;
        routeIndex++
      ) {
        const pattern = route.segments[routeIndex];
        if (pattern.kind === "wildcard") {
          patternParams[pattern.name] = segments
            .slice(pathIndex)
            .map((segment) => decodePathSegment(segment, normalizedPath))
            .join("/");
          pathIndex = segments.length;
          break;
        }

        const segment = segments[pathIndex];
        if (segment === undefined) {
          if (pattern.kind === "param" && pattern.optional) continue;
          matched = false;
          break;
        }
        if (pattern.kind === "static" && segment !== pattern.value) {
          matched = false;
          break;
        }
        if (pattern.kind === "param") {
          const decoded = decodePathSegment(segment, normalizedPath);
          if (pattern.expression && !pattern.expression.test(decoded)) {
            matched = false;
            break;
          }
          patternParams[pattern.name] = decoded;
        }
        pathIndex++;
      }

      if (matched && pathIndex === segments.length) {
        return { handler: route.handler, params: patternParams };
      }
    }

    return null;
  }

  /** Retorna os métodos registrados que correspondem ao caminho. */
  allowedMethods(path: string): string[] {
    const methods = [
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ];
    return methods.filter((method) => this.find(method, path) !== null);
  }
}
