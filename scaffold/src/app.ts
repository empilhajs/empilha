import { createApplication } from "empilha";
import { AppModule } from "./modules/app.module";
import config from "../empilha.config";

const app = await createApplication(AppModule, {
  runtime: config,
});

await app.run();
