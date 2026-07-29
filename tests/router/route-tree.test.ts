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
  });

  test("faz backtracking entre rota estática e parametrizada", () => {
    const router = new RouteTree();

    router.insert("GET", "/files/:id", () => "param");

    router.insert("GET", "/files/new/edit", () => "static");

    expect(router.find("GET", "/files/new")?.params).toEqual({
      id: "new",
    });

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
});
