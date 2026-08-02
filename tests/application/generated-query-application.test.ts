import { describe, expect, test } from "bun:test";
import { createApplication } from "../../src/application/application";
import { Controller, Get, Result, Sql } from "../../src/decorators";
import { defineGeneratedQuery } from "../../src/sql/generated-query";
import { defineModule } from "../../src/modules";
import { testPostgres } from "../../src/application/testing/test-postgres";
import { Type as t } from "@sinclair/typebox";

const listTasks = defineGeneratedQuery({
  id: "tasks/list",
  source: "src/tasks.sql:1",
  cardinality: "many",
  sql: "SELECT id FROM tasks",
  row: t.Object({ id: t.Number() }),
});

@Controller("/generated-tasks")
class GeneratedTaskController {
  @Get("/")
  @Sql(listTasks)
  @Result("many")
  list() {}
}

describe("generated query application contract", () => {
  test("registra o SQL do artefato e executa a cardinalidade declarada", async () => {
    const database = testPostgres([{ id: 1, ignored: true }]);
    const app = await createApplication(
      defineModule({
        name: "generated",
        controllers: [GeneratedTaskController],
        queries: [listTasks],
      }),
      {
        configure: (configured) =>
          configured.postgres(database, { healthCheck: false }),
      },
    );

    const response = await app.fetch(
      new Request("http://test/generated-tasks", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1 }]);
    await app.close();
  });

  test("rejeita @Result incompatível com o artefato", async () => {
    const execute = defineGeneratedQuery({
      id: "tasks/execute",
      source: "src/tasks.sql:8",
      cardinality: "exec",
      sql: "DELETE FROM tasks",
    });
    @Controller("/invalid-generated")
    class InvalidGeneratedController {
      @Get("/")
      @Sql(execute)
      @Result("many")
      run() {}
    }

    await expect(
      createApplication(
        defineModule({
          name: "invalid-generated",
          controllers: [InvalidGeneratedController],
          queries: [execute],
        }),
      ),
    ).rejects.toThrow("cardinalidade");
  });

  test("rejeita bindings do artifact divergentes do SQL", async () => {
    const artifact = defineGeneratedQuery({
      id: "tasks/list",
      source: "tasks.sql:1",
      cardinality: "many",
      bindings: { "query.page": "number" },
      sql: "SELECT * FROM tasks WHERE owner = :auth.sub",
    });

    @Controller("/tasks")
    class TaskController {
      @Get("/")
      @Sql(artifact)
      @Result("many")
      list() {}
    }

    await expect(
      createApplication(
        defineModule({
          name: "tasks",
          controllers: [TaskController],
          queries: [artifact],
        }),
      ),
    ).rejects.toThrow(
      /query "tasks\/list".*rota GET \/tasks.*Origem do artifact: tasks\.sql:1/is,
    );
  });

  test("rejeita binding auth sem identidade declarada na rota", async () => {
    const artifact = defineGeneratedQuery({
      id: "tasks/current-user",
      source: "tasks.sql:14",
      cardinality: "many",
      bindings: { "auth.sub": "string" },
      sql: "SELECT * FROM tasks WHERE owner = :auth.sub",
    });

    @Controller("/unauthenticated-query")
    class UnauthenticatedQueryController {
      @Get("/")
      @Sql(artifact)
      @Result("many")
      list() {}
    }

    await expect(
      createApplication(
        defineModule({
          name: "unauthenticated-query",
          controllers: [UnauthenticatedQueryController],
          queries: [artifact],
        }),
      ),
    ).rejects.toThrow("exige uma rota protegida");
  });

  test("rejeita tipo de binding divergente do cast SQL", async () => {
    const artifact = defineGeneratedQuery({
      id: "tasks/typed",
      source: "tasks.sql:20",
      cardinality: "many",
      bindings: { "query.page": "number" },
      sql: "SELECT * FROM tasks WHERE page = :query.page::text",
    });

    @Controller("/typed-tasks")
    class TypedTaskController {
      @Get("/")
      @Sql(artifact)
      @Result("many")
      list() {}
    }

    await expect(
      createApplication(
        defineModule({
          name: "typed-tasks",
          controllers: [TypedTaskController],
          queries: [artifact],
        }),
      ),
    ).rejects.toThrow('é "number", mas o SQL infere "string"');
  });
});
