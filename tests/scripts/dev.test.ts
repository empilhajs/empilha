import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { testPort } from "../helpers/test-utils";

async function waitForOutput(
  output: () => string,
  fragment: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(fragment)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Saída não encontrada: ${fragment}\n${output()}`);
}

describe("dev supervisor", () => {
  test("mantém o servidor anterior em build inválido e reinicia após correção", async () => {
    const directory = mkdtempSync(join(tmpdir(), "empilha-dev-test-"));
    const root = process.cwd();
    const modulesSource = pathToFileURL(
      join(root, "src/modules/index.ts"),
    ).href;
    const applicationSource = pathToFileURL(
      join(root, "src/application/application.ts"),
    ).href;
    const devPort = testPort();
    const devScript = join(root, "scripts/application/dev.ts");
    const moduleFile = join(directory, "src/modules/app.module.ts");
    const appFile = join(directory, "src/app.ts");
    const validModule = `import { defineModule } from "${modulesSource}";
export const AppModule = defineModule({ name: "dev-test" });
`;
    const invalidModule = `import { defineModule } from "${modulesSource}";
import { createToken } from "${pathToFileURL(join(root, "src/di/index.ts")).href}";
const missing = createToken("dev-test/missing");
export const AppModule = defineModule({ name: "dev-test", exports: [missing] });
`;

    mkdirSync(join(directory, "src/modules"), { recursive: true });
    writeFileSync(moduleFile, validModule);
    writeFileSync(
      appFile,
      `import { createApplication } from "${applicationSource}";
import { AppModule } from "./modules/app.module.ts";
const app = await createApplication(AppModule);
await app.listen(${devPort});
`,
    );

    const child = Bun.spawn([process.execPath, devScript, "src/app.ts"], {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        output += decoder.decode(chunk.value, { stream: true });
      }
    };
    const readers = [read(child.stdout), read(child.stderr)];

    try {
      await waitForOutput(
        () => output,
        "✓ Build válido; iniciando o servidor.",
      );
      writeFileSync(moduleFile, invalidModule);
      await waitForOutput(
        () => output,
        "⚠ Build inválido; o processo atual continua até um rebuild válido.",
      );
      expect(child.exitCode).toBeNull();

      writeFileSync(moduleFile, validModule);
      await waitForOutput(
        () => output,
        "✓ Rebuild válido; servidor reiniciado.",
      );
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(2_000)]);
      await Promise.allSettled(readers);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
