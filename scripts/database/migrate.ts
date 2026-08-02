import path from "node:path";
import { runMigrations } from "./migrations";

const directoryArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--dir="));
const directory = path.resolve(
  directoryArg?.slice("--dir=".length) ?? "src/database",
);

await runMigrations({ directory });
