import { jwt } from "../../packages/jwt/src/index";
import { postgres } from "../../packages/pg/src/index";

export const integrations = {
  database: postgres({ url: "postgresql://example.invalid/db" }),
  auth: jwt({
    name: "bundle",
    secret: "bundle-secret-with-at-least-32-bytes-long",
  }),
};
