import { describe, expect, test } from "bun:test";
import { HttpError, ValidationError } from "../../src/errors/index";
import {
  createErrorResponse,
  ErrorPipeline,
} from "../../src/runtime/error-pipeline";

describe("ErrorPipeline", () => {
  test("converte erros HTTP e validação em respostas", async () => {
    const pipeline = new ErrorPipeline();
    const handler = pipeline.createHandler(Object.prototype, () => undefined);

    expect(await handler(new HttpError(409, "conflict"))).toEqual({
      status: 409,
      body: JSON.stringify({
        type: "about:blank",
        title: "conflict",
        status: 409,
      }),
      headers: { "Content-Type": "application/problem+json" },
    });

    expect(
      await handler(new ValidationError([{ path: "id", message: "bad" }])),
    ).toEqual({
      status: 400,
      body: JSON.stringify({
        type: "about:blank",
        title: "Validation failed",
        status: 400,
        errors: [{ path: "id", message: "bad" }],
      }),
      headers: { "Content-Type": "application/problem+json" },
    });
  });

  test("prioriza catcher global e converte falha do catcher", async () => {
    const pipeline = new ErrorPipeline();
    pipeline.catch(Error, () => createErrorResponse(418, "handled"));

    const handler = pipeline.createHandler(Object.prototype, () => undefined);
    expect(await handler(new Error("boom"))).toEqual(
      createErrorResponse(418, "handled"),
    );

    const failing = new ErrorPipeline();
    failing.catch(Error, () => {
      throw new HttpError(422, "catcher failed");
    });

    const failingHandler = failing.createHandler(
      Object.prototype,
      () => undefined,
    );
    expect(await failingHandler(new Error("boom"))).toEqual(
      createErrorResponse(422, "catcher failed"),
    );
  });
});
