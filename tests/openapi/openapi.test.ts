import { describe, expect, test } from "bun:test";
import {
  Body,
  Controller,
  createApplication,
  Get,
  Header,
  HeaderParams,
  Param,
  Post,
  QueryParams,
  Query,
  Request,
  Roles,
  Returns,
  Status,
  t,
  type OpenApiDocument,
} from "../../src";
import { testAuthPlugin, testModule } from "../helpers/test-utils";
import { OpenApiDocumentBuilder } from "../../src/openapi";
import type { RegisteredRouteMetadata } from "../../src/core/types";

describe("Empilha OpenAPI", () => {
  test("reutiliza a gramática de rotas e expande parâmetro opcional", () => {
    const builder = new OpenApiDocumentBuilder();
    const route = {
      parameters: [],
      propertyKey: "find",
      method: "GET",
    } as unknown as RegisteredRouteMetadata;

    builder.addRoute("Files", "/files/:id<\\d+>?", route);
    builder.addRoute("Assets", "/assets/*rest", {
      ...route,
      propertyKey: "asset",
    });
    const document = builder.build();

    expect(document.paths["/files"].get.parameters).toBeUndefined();
    expect(document.paths["/files/{id}"].get.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", pattern: "\\d+" },
    });
    expect(document.paths["/assets/{rest}"].get.parameters).toContainEqual({
      name: "rest",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    expect(() =>
      builder.addRoute("Broken", "/files/*rest/tail", route),
    ).toThrow("Wildcard deve ser o último segmento");
  });

  test("publica todas as respostas declaradas por status", () => {
    const success = t.Object({ id: t.Number() });
    const failure = t.Object({ error: t.String() });
    const route = {
      parameters: [],
      propertyKey: "create",
      method: "POST",
      path: "/responses",
      responses: { "201": success, "400": failure },
    } as unknown as RegisteredRouteMetadata;
    const builder = new OpenApiDocumentBuilder();
    builder.addRoute("Responses", "/responses", route);

    const responses = builder.build().paths["/responses"].post.responses;
    expect(responses["201"]?.content?.["application/json"]?.schema).toBe(
      success,
    );
    expect(responses["400"]?.content?.["application/json"]?.schema).toBe(
      failure,
    );
  });

  test("publica headers declarados por schema", async () => {
    @Controller("/headers")
    class HeadersController {
      @Get("/")
      @HeaderParams(
        t.Object({
          "x-api-key": t.String(),
        }),
      )
      get() {
        return { ok: true };
      }
    }

    const app = await createApplication(testModule([HeadersController]), {
      configure: (runtime) => runtime.openapi(),
    });
    const document = (await (
      await app.test().get("/openapi.json")
    ).json()) as OpenApiDocument;
    const operation = document.paths["/headers"].get;
    expect(operation.parameters).toContainEqual({
      name: "x-api-key",
      in: "header",
      required: true,
      schema: expect.objectContaining({ type: "string" }),
    });
  });

  test("isola respostas OpenAPI entre operações que compartilham schema", () => {
    const schema = t.Object({ ok: t.Boolean() });
    const route = {
      parameters: [],
      propertyKey: "get",
      method: "GET",
      responseSchema: schema,
    } as unknown as RegisteredRouteMetadata;
    const builder = new OpenApiDocumentBuilder();

    builder.addRoute("First", "/first", route);
    builder.addRoute("Second", "/second", {
      ...route,
      propertyKey: "other",
    });

    const document = builder.build();
    document.paths["/first"].get.responses["200"].description = "Changed";

    expect(document.paths["/second"].get.responses["200"].description).toBe(
      "Successful response",
    );
  });

  test("gera contrato e Swagger UI com apenas app.openapi()", async () => {
    const input = t.Object({
      name: t.String(),
    });
    const output = t.Object({
      id: t.Number(),
      name: t.String(),
    });

    @Controller("/users")
    class Users {
      @Get("/:id")
      @Returns(output)
      @Roles("admin")
      find(
        @Param("id", Number) _id: number,
        @Query("include", t.Boolean()) _include: boolean,
        @Header("x-request-id") _requestId: string,
      ) {
        return {
          id: 1,
          name: "Ada",
        };
      }

      @Post("/")
      @Status(202)
      @Body(input)
      @Returns(output)
      create(@Request() request: { body: { name: string } }) {
        return {
          id: 1,
          name: request.body.name,
        };
      }
    }

    const app = await createApplication(
      testModule([Users], {
        plugins: [testAuthPlugin(() => ({ valid: true, roles: ["admin"] }))],
      }),
      {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false }).openapi({
            title: "Users API",
            version: "2.0.0",
          }),
      },
    );

    const documentResponse = await app.test().get("/openapi.json");
    const document = (await documentResponse.json()) as OpenApiDocument;
    const find = document.paths["/users/{id}"]?.get;
    const create = document.paths["/users"]?.post;

    expect(documentResponse.status).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({
      title: "Users API",
      version: "2.0.0",
    });
    expect(create?.responses["408"]?.description).toBe("Request Timeout");
    expect(create?.responses["413"]?.description).toBe("Payload Too Large");
    expect(create?.responses["415"]?.description).toBe(
      "Unsupported Media Type",
    );
    expect(create?.responses["503"]?.description).toBe("Service Unavailable");
    expect(create?.responses["504"]?.description).toBe("Gateway Timeout");
    expect(find?.operationId).toBe("Users.find");
    expect(find?.parameters?.map((parameter) => parameter.in)).toEqual([
      "path",
      "query",
      "header",
    ]);
    expect(find?.parameters?.[1]?.schema).toEqual({
      type: "boolean",
    });
    expect(find?.security).toEqual([
      {
        bearerAuth: [],
      },
    ]);
    expect(create?.requestBody?.content["application/json"].schema.type).toBe(
      "object",
    );
    expect(
      create?.requestBody?.content["application/json"].schema.properties,
    ).toEqual({
      name: {
        type: "string",
      },
    });
    expect(create?.responses["202"]).toBeDefined();
    const validationSchema = create?.responses["400"]?.content?.[
      "application/problem+json"
    ].schema as { properties?: Record<string, unknown> };
    expect(validationSchema.properties).toEqual(
      expect.objectContaining({
        type: expect.anything(),
        title: expect.anything(),
        status: expect.anything(),
        errors: expect.anything(),
      }),
    );
    expect(document.components?.securitySchemes.bearerAuth.scheme).toBe(
      "bearer",
    );

    const docs = await app.test().get("/docs");

    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    const docsHtml = await docs.text();
    expect(docsHtml).toContain("/openapi.json");
    expect(docsHtml).toContain("swagger-ui-bundle.js");
  });

  test("inclui no documento as rotas compiladas do módulo", async () => {
    @Controller("/late")
    class Late {
      @Get("/")
      get() {
        return {
          ok: true,
        };
      }
    }

    const app = await createApplication(testModule([Late]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }).openapi(),
    });
    const document = (await (
      await app.test().get("/openapi.json")
    ).json()) as OpenApiDocument;

    expect(document.paths["/late"]?.get).toBeDefined();
  });

  test("herda tags, middleware e auth do controller", async () => {
    let middlewareCalls = 0;

    @Controller("/admin", {
      tags: ["Administration"],
      auth: "admin",
      middlewares: [
        async (_request, next) => {
          middlewareCalls++;
          return next();
        },
      ],
    })
    class Admin {
      @Get("/:id")
      get() {
        return { ok: true };
      }
    }

    const app = await createApplication(
      testModule([Admin], {
        plugins: [testAuthPlugin(() => ({ valid: true, roles: ["admin"] }))],
      }),
      {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false }).openapi(),
      },
    );

    expect((await app.test().get("/admin/1")).status).toBe(401);
    expect(
      (
        await app.test().get("/admin/1", {
          headers: { authorization: "Bearer test" },
        })
      ).status,
    ).toBe(200);
    expect(middlewareCalls).toBe(2);

    const document = (await (
      await app.test().get("/openapi.json")
    ).json()) as OpenApiDocument;
    const operation = document.paths["/admin/{id}"]?.get;

    expect(operation?.tags).toEqual(["Administration"]);
    expect(operation?.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ]);
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  });

  test("aceita auth sem role no controller", async () => {
    @Controller("/me", { auth: true })
    class Profile {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    const app = await createApplication(
      testModule([Profile], {
        plugins: [testAuthPlugin(() => ({ valid: true }))],
      }),
      {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false }).openapi(),
      },
    );

    expect((await app.test().get("/me/")).status).toBe(401);
    expect(
      (
        await app.test().get("/me/", {
          headers: { authorization: "Bearer token" },
        })
      ).status,
    ).toBe(200);

    const document = (await (
      await app.test().get("/openapi.json")
    ).json()) as OpenApiDocument;
    expect(document.paths["/me"]?.get?.security).toEqual([{ bearerAuth: [] }]);
  });

  test("documenta query params tipados, defaults e erros padronizados", async () => {
    @Controller("/search", { auth: true })
    class Search {
      @Get("/")
      @QueryParams(
        t.Object({ limit: t.Integer(), term: t.Optional(t.String()) }),
        { limit: 20 },
      )
      get() {
        return { ok: true };
      }
    }

    const app = await createApplication(
      testModule([Search], {
        plugins: [testAuthPlugin(() => ({ valid: true }))],
      }),
      {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false }).openapi(),
      },
    );
    const document = (await (
      await app.test().get("/openapi.json")
    ).json()) as OpenApiDocument;
    const operation = document.paths["/search"]?.get;

    expect(operation?.parameters?.[0]?.name).toBe("limit");
    expect(operation?.parameters?.[0]?.required).toBe(false);
    expect(operation?.parameters?.[0]?.schema).toMatchObject({
      type: "integer",
      default: 20,
    });
    expect(operation?.parameters?.[1]?.name).toBe("term");
    expect(operation?.parameters?.[1]?.schema).toMatchObject({
      type: "string",
    });
    expect(
      operation?.responses["400"]?.content?.["application/problem+json"]
        ?.schema,
    ).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          status: expect.any(Object),
          title: expect.any(Object),
        }),
      }),
    );
    expect(operation?.responses["401"]).toBeDefined();
    expect(operation?.responses["403"]).toBeDefined();
  });
});
