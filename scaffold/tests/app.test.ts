import { describe, expect, test } from "bun:test";
import { createTestApplication } from "empilha";
import { AppModule } from "../src/modules/app.module";

describe("scaffold", () => {
  test("responde à rota inicial sem abrir uma porta", async () => {
    const app = await createTestApplication(AppModule).compile();
    const response = await app.fetch(new Request("http://test/"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Empilha 0.2",
    });

    await app.close();
  });
});
