import { defineModule } from "empilha";
import { AppController } from "../controllers/app.controller";
import { AppService } from "../services/app.service";

export const AppModule = defineModule({
  name: "app",
  controllers: [AppController],
  providers: [AppService],
});
