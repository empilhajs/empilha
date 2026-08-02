import { describe, expect, test } from "bun:test";
import { collectSqlSources } from "../../src/application/bootstrap/sql-binding-validation";

describe("SQL binding source detection", () => {
  test("ignora strings e comentários SQL", () => {
    const sources = collectSqlSources(`
      SELECT ':body.secret', $$ :query.fake $$, :param.id
      -- :body.comment
      /* :header.fake */
    `);

    expect([...sources]).toEqual(["param"]);
  });
});
