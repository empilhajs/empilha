import { Injectable } from "empilha";

@Injectable({ scope: "singleton" })
export class AppService {
  getMessage(): string {
    return "Hello from Empilha";
  }
}
