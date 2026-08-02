import { Injectable } from "empilha";

@Injectable({ scope: "singleton" })
export class AppService {
  message(): string {
    return "Empilha 0.2";
  }
}
