import { postgres } from "../../packages/pg/src/index";

export const database = postgres({ url: "postgresql://example.invalid/db" });
