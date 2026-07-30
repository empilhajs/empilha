import { defineConfig } from "empilha";

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 4000,
  },
  http: {
    cors: process.env.CORS_ORIGIN || false,
  },
  logging: {
    requests: true,
  },
  openapi: {
    title: "Empilha API",
    version: "1.0.0",
  },
  database: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5432/app",
    sql: "./src/queries",
    healthCheck: "postgres",
  },
});
