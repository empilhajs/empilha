import { describe, expect, test } from "bun:test";
import { migrationScript } from "../../scripts/database/migrations";

describe("migrations", () => {
  test("aplica arquivos e histórico sob o mesmo lock transacional", () => {
    const script = migrationScript([
      {
        file: "/tmp/001-create-users.sql",
        name: "001-create-users.sql",
        checksum: "abc123",
      },
    ]);

    expect(script).toContain("BEGIN;");
    expect(script).toContain(
      "SELECT pg_advisory_xact_lock(hashtext('empilha:migrations'));",
    );
    expect(script).toContain("CREATE TABLE IF NOT EXISTS empilha_migrations");
    expect(script).toContain("WHERE name = '001-create-users.sql'");
    expect(script).toContain("\\if :apply_migration");
    expect(script).toContain("\\i '/tmp/001-create-users.sql'");
    expect(script).toContain(
      "INSERT INTO empilha_migrations (name, checksum) VALUES ('001-create-users.sql', 'abc123');",
    );
    expect(script.lastIndexOf("COMMIT;")).toBeGreaterThan(
      script.lastIndexOf("INSERT INTO empilha_migrations"),
    );
  });
});
