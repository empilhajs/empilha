import { Controller, Get, Inject } from "empilha";
import { AppService } from "../services/app.service";

@Controller("/")
export class AppController {
  constructor(
    @Inject(AppService)
    private readonly appService: AppService,
  ) {}

  @Get("/")
  index() {
    return { message: this.appService.getMessage() };
  }
}
