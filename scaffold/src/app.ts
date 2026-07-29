import { Empilha } from "empilha";
import { Pool } from "pg";
import { AppController } from "./controllers/app.controller";
import config from "../empilha.config";

const { url, ...database } = config.database;
const pool = new Pool({ connectionString: url });

const app = new Empilha()
  .configure(config)
  .postgres(pool, database)
  .initialize([AppController]);

await app.run();
