import { describe, expect, test } from "bun:test";
import { createTestApp } from "empilha";
import { AppController } from "../src/controllers/app.controller";

describe("scaffold", () => {
  test("responde à rota inicial sem abrir uma porta", async () => {
    const app = createTestApp([AppController]);
    const response = await app.test().get("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Hello from Empilha",
    });

    await app.close();
  });
});
