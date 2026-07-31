import { describe, expect, test } from "bun:test";
import {
  Body,
  Controller,
  Empilha,
  Get,
  Header,
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

describe("Empilha OpenAPI", () => {
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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .openapi({
        title: "Users API",
        version: "2.0.0",
      })
      .auth(() => ({ valid: true, roles: ["admin"] }))
      .validate([Users])
      .initialize([Users]);

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
      "application/json"
    ].schema as { anyOf?: unknown[] };
    expect(validationSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({ error: expect.anything() }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({ errors: expect.anything() }),
        }),
      ]),
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

  test("pode ser ativado depois do registro", async () => {
    @Controller("/late")
    class Late {
      @Get("/")
      get() {
        return {
          ok: true,
        };
      }
    }

    const app = new Empilha()
      .configureHttp({ cors: false })
      .validate([Late])
      .initialize([Late])
      .openapi();
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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .openapi()
      .auth(() => ({ valid: true, roles: ["admin"] }))
      .validate([Admin])
      .initialize([Admin]);

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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .openapi()
      .auth(() => ({ valid: true }))
      .validate([Profile])
      .initialize([Profile]);

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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .openapi()
      .auth(() => ({ valid: true }))
      .validate([Search])
      .initialize([Search]);
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
      operation?.responses["400"]?.content?.["application/json"]?.schema,
    ).toEqual(expect.objectContaining({ anyOf: expect.any(Array) }));
    expect(operation?.responses["401"]).toBeDefined();
    expect(operation?.responses["403"]).toBeDefined();
  });
});
