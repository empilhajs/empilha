import { normalizeMethod, normalizePath, splitPath } from "./path";
import { createStringRecord, EMPTY_STRING_RECORD } from "../utils/records";

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
  private readonly root = createNode<THandler>();

  /**
   * Índice medido para rotas totalmente estáticas.
   * A árvore continua sendo a fonte de registro e validação.
   */
  private readonly staticHandlers = Object.create(null) as Record<
    string,
    RouteMatch<THandler>
  >;

  /** Valida várias inserções sem alterar a árvore atual. */
  assertCanInsert(routes: readonly { method: string; path: string }[]): void {
    const copy = this.clone();
    const placeholder = (() => undefined) as THandler;

    for (const route of routes) {
      copy.insert(route.method, route.path, placeholder);
    }
  }

  /** Captura o estado atual para permitir rollback de um registro parcial. */
  snapshot(): RouteTree<THandler> {
    return this.clone();
  }

  /** Restaura um snapshot previamente capturado. */
  restore(snapshot: RouteTree<THandler>): void {
    const restored = snapshot.clone();
    Object.assign(this.root, restored.root);

    for (const key of Object.keys(this.staticHandlers)) {
      delete this.staticHandlers[key];
    }
    Object.assign(this.staticHandlers, restored.staticHandlers);
  }

  private clone(): RouteTree<THandler> {
    const copy = new RouteTree<THandler>();

    const cloneNode = (node: RouteNode<THandler>): RouteNode<THandler> => ({
      handlers: new Map(node.handlers),
      staticChildren: new Map(
        [...node.staticChildren].map(([segment, child]) => [
          segment,
          cloneNode(child),
        ]),
      ),
      paramChild: node.paramChild
        ? {
            name: node.paramChild.name,
            node: cloneNode(node.paramChild.node),
          }
        : null,
    });

    Object.assign(copy.root, cloneNode(this.root));
    Object.assign(copy.staticHandlers, this.staticHandlers);
    return copy;
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

    if (!segments.some((segment) => paramRegex.test(segment))) {
      this.staticHandlers[`${normalizedMethod} ${normalizedPath}`] =
        Object.freeze({
          handler,
          params: EMPTY_STRING_RECORD,
        });
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

    return null;
  }
}
