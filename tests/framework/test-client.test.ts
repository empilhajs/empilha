import { describe, expect, test } from "bun:test";
import {
  Body,
  Controller,
  Delete,
  Empilha,
  Get,
  Header,
  Param,
  Status,
  t,
} from "../../src";

describe("test client", () => {
  test("funciona sem servidor e preserva false, 0, null e string vazia", async () => {
    class Values {
      @Get("/false")
      false() {
        return false;
      }

      @Get("/zero")
      zero() {
        return 0;
      }

      @Get("/null")
      null() {
        return null;
      }

      @Get("/empty")
      empty() {
        return "";
      }
    }

    Controller("/values")(Values);

    const app = new Empilha().configureHttp({ cors: false });

    app.validate([Values]).initialize([Values]);

    const falseResponse = await app.test().get("/values/false");
    const zeroResponse = await app.test().get("/values/zero");
    const nullResponse = await app.test().get("/values/null");
    const emptyResponse = await app.test().get("/values/empty");

    expect(await falseResponse.json()).toBe(false);

    expect(await zeroResponse.json()).toBe(0);

    expect(await nullResponse.json()).toBeNull();

    expect(await emptyResponse.json()).toBe("");
  });

  test("cliente acessa rota parametrizada", async () => {
    class Hello {
      @Get("/hello/:name")
      hello(name: string) {
        return {
          message: `Hello ${name}!`,
        };
      }
    }

    Param("name")(Hello.prototype, "hello", 0);

    Controller("/api")(Hello);

    const app = new Empilha().configureHttp({ cors: false });

    app.validate([Hello]).initialize([Hello]);

    const response = await app.test().get("/api/hello/mundo");

    expect(await response.json()).toEqual({
      message: "Hello mundo!",
    });
  });

  test("aceita headers no cliente de teste", async () => {
    class Protected {
      @Get("/")
      value(token: string) {
        return token;
      }
    }

    Header("X-Token")(Protected.prototype, "value", 0);
    Controller("/protected")(Protected);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Protected]).initialize([Protected]);

    const response = await app.test().get("/protected", {
      headers: {
        "x-token": "abc",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toBe("abc");
  });

  test("oferece delete", async () => {
    class Resources {
      @Delete("/")
      remove() {}
    }

    Controller("/resources")(Resources);

    const client = new Empilha()
      .configureHttp({ cors: false })
      .validate([Resources])
      .initialize([Resources])
      .test();

    expect((await client.delete("/resources")).status).toBe(204);
  });

  test("trata objeto com headers como body de DELETE", async () => {
    class Resources {
      @Delete("/")
      @Status(200)
      remove(@Body(t.Object({ headers: t.String() })) body: unknown) {
        return body;
      }
    }

    Controller("/delete-body")(Resources);
    const client = new Empilha()
      .configureHttp({ cors: false })
      .validate([Resources])
      .initialize([Resources])
      .test();
    const response = await client.delete("/delete-body", { headers: "body" });

    expect(await response.json()).toEqual({ headers: "body" });
  });
});
