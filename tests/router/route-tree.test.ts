import { describe, expect, test } from "bun:test";
import { RouteTree } from "../../src/router/route-tree";

describe("RouteTree", () => {
  test("resolve a rota raiz", () => {
    const router = new RouteTree();
    const handler = () => "root";

    router.insert("GET", "/", handler);

    expect(router.find("GET", "/")?.handler).toBe(handler);

    expect(router.find("GET", "////")?.params).toEqual({});
  });

  test("normaliza método, barras consecutivas e trailing slash", () => {
    const router = new RouteTree();

    router.insert(" get ", "//users//", () => "ok");

    expect(router.find("GET", "/users/")?.params).toEqual({});
  });

  test("prioriza rota estática sobre parametrizada", () => {
    const router = new RouteTree();

    router.insert("GET", "/files/:id", () => "param");

    router.insert("GET", "/files/new", () => "static");

    expect(router.find("GET", "/files/new")?.handler()).toBe("static");
    expect(router.find("GET", "/files/new")?.path).toBe("/files/new");
  });

  test("faz backtracking entre rota estática e parametrizada", () => {
    const router = new RouteTree();

    router.insert("GET", "/files/:id", () => "param");

    router.insert("GET", "/files/new/edit", () => "static");

    expect(router.find("GET", "/files/new")?.params).toEqual({
      id: "new",
    });
    expect(router.find("GET", "/files/new")?.path).toBe("/files/:id");

    expect(router.find("GET", "/files/new/edit")?.params).toEqual({});
  });

  test("rejeita conflito entre nomes de parâmetros", () => {
    const router = new RouteTree();

    router.insert("GET", "/users/:id", () => "ok");

    expect(() => {
      router.insert("GET", "/users/:userId", () => "again");
    }).toThrow("Parâmetro conflitante");
  });

  test("permite métodos HTTP diferentes na mesma rota", () => {
    const router = new RouteTree();

    router.insert("GET", "/users", () => "get");

    router.insert("POST", "/users", () => "post");

    expect(router.find("GET", "/users")?.handler()).toBe("get");

    expect(router.find("post", "/users")?.handler()).toBe("post");
  });

  test("trata HEAD como GET quando não existe rota HEAD explícita", () => {
    const router = new RouteTree();
    const handler = () => "get";

    router.insert("GET", "/users", handler);

    expect(router.find("HEAD", "/users")?.handler).toBe(handler);
  });

  test("decodifica parâmetro e rejeita segmento codificado inválido", () => {
    const router = new RouteTree();

    router.insert("GET", "/users/:name", () => "ok");

    expect(router.find("GET", "/users/Jo%C3%A3o")?.params).toEqual({
      name: "João",
    });

    expect(() => {
      router.find("GET", "/users/%E0%A4%A");
    }).toThrow("Segmento");
  });

  test("rejeita parâmetros malformados e protege propriedades especiais", () => {
    const router = new RouteTree();

    expect(() => {
      router.insert("GET", "/users/:1id", () => "bad");
    }).toThrow("Parâmetro inválido");

    router.insert("GET", "/:__proto__", () => "safe");

    const params = router.find("GET", "/value")?.params;

    expect(params?.["__proto__"]).toBe("value");

    expect(Object.getPrototypeOf(params)).toBeNull();
  });

  test("rejeita rota duplicada", () => {
    const router = new RouteTree();

    router.insert("GET", "/users/:name", () => "ok");

    expect(() => {
      router.insert("GET", "/users/:name", () => "again");
    }).toThrow("Rota duplicada");
  });

  test("suporta wildcard, parâmetro opcional e expressão regular", () => {
    const router = new RouteTree();
    const wildcard = () => "wildcard";
    const optional = () => "optional";
    const numeric = () => "numeric";

    router.insert("GET", "/assets/*path", wildcard);
    router.insert("GET", "/users/:id?", optional);
    router.insert("GET", "/orders/:id<[0-9]+>", numeric);

    expect(router.find("GET", "/assets/css/app.css")).toMatchObject({
      handler: wildcard,
      params: { path: "css/app.css" },
    });
    expect(router.find("GET", "/users")?.handler).toBe(optional);
    expect(router.find("GET", "/orders/42")?.handler).toBe(numeric);
    expect(router.find("GET", "/assets/css/app.css")?.path).toBe(
      "/assets/*path",
    );
    expect(router.find("GET", "/orders/abc")).toBeNull();
  });

  test("rejeita wildcard e parâmetro opcional fora da posição terminal", () => {
    const router = new RouteTree();

    expect(() =>
      router.insert("GET", "/files/*rest/tail", () => "bad"),
    ).toThrow("Wildcard deve ser o último segmento");
    expect(() => router.insert("GET", "/users/:id?/edit", () => "bad")).toThrow(
      "Parâmetro opcional deve ser o último segmento",
    );
  });

  test("remove também valida a mesma gramática de padrões", () => {
    const router = new RouteTree();
    const remove = (
      router as unknown as {
        remove(method: string, path: string): void;
      }
    ).remove.bind(router);

    expect(() => remove("GET", "/files/*rest/tail")).toThrow(
      "Wildcard deve ser o último segmento",
    );
    expect(() => remove("GET", "/users/:id?/edit")).toThrow(
      "Parâmetro opcional deve ser o último segmento",
    );
  });

  test("rejeita expressões regulares concorrentes na mesma posição", () => {
    const router = new RouteTree();
    const numeric = () => "numeric";

    router.insert("GET", "/value/:id<[0-9]+>", numeric);
    expect(() =>
      router.insert("GET", "/value/:id<[a-z]+>", () => "alphabetic"),
    ).toThrow("Rotas ambíguas");
  });

  test("rejeita shadowing entre rota genérica e rota restrita em ambas as ordens", () => {
    for (const routes of [
      ["/files/:id", "/files/:id<[0-9]+>"],
      ["/files/:id<[0-9]+>", "/files/:id"],
    ]) {
      const router = new RouteTree();
      router.insert("GET", routes[0], () => "public");
      expect(() => router.insert("GET", routes[1], () => "protected")).toThrow(
        "Rotas ambíguas",
      );
    }
  });

  test("rejeita padrões regex amplos e estreitos em ambas as ordens", () => {
    for (const routes of [
      ["/value/:id<.+>", "/value/:id<[0-9]+>"],
      ["/value/:id<[0-9]+>", "/value/:id<.+>"],
    ]) {
      const router = new RouteTree();
      router.insert("GET", routes[0], () => "public");
      expect(() => router.insert("GET", routes[1], () => "protected")).toThrow(
        "Rotas ambíguas",
      );
    }
  });

  test("lista métodos permitidos para um caminho", () => {
    const router = new RouteTree();
    router.insert("GET", "/users", () => "get");
    router.insert("POST", "/users", () => "post");

    expect(router.allowedMethods("/users")).toEqual(["GET", "HEAD", "POST"]);
  });

  test("lista métodos permitidos em parâmetros e padrões", () => {
    const router = new RouteTree();
    router.insert("GET", "/orders/:id", () => "get");
    router.insert("DELETE", "/orders/:id", () => "delete");
    router.insert("PATCH", "/assets/*path", () => "patch");

    expect(router.allowedMethods("/orders/42")).toEqual([
      "GET",
      "HEAD",
      "DELETE",
    ]);
    expect(router.allowedMethods("/assets/css/app.css")).toEqual(["PATCH"]);
    expect(router.allowedMethods("/unknown")).toEqual([]);
  });
});
