# @empilha/jwt

Integra JWT ao Empilha usando `jose`, sem acoplar o framework principal ao
provedor de tokens.

```ts
import { Empilha } from "empilha"
import { jwt } from "@empilha/jwt"

const app = new Empilha().usePlugin(
  jwt({
    name: "access",
    secret: process.env.JWT_SECRET!,
    // Gere uma chave aleatória com pelo menos 32 bytes.
  }).auth(),
)
```

Tokens de acesso expiram em 15 minutos por padrão. Tokens de refresh devem ser
criados com `name: "refresh"` (ou `tokenUse: "refresh"`) e expiram em 7 dias por
padrão. O segredo precisa ter pelo menos 32 bytes.
