import { RouteTree } from "../../src/router/route-tree";

const router = new RouteTree<() => string>();
const handler = () => "ok";
router.insert("GET", "/tasks/:id", handler);
router.insert("POST", "/tasks/:id", handler);
router.insert("PATCH", "/tasks/:id", handler);
router.insert("GET", "/tasks/search", handler);

const iterations = 1_000_000;
const measure = (name: string, operation: () => unknown): void => {
  const started = performance.now();
  for (let index = 0; index < iterations; index++) operation();
  const elapsed = performance.now() - started;
  console.log(
    `${name}: ${iterations.toLocaleString("en-US")} ops em ${elapsed.toFixed(2)} ms`,
  );
};

measure("route find", () => router.find("GET", "/tasks/42"));
measure("route allowedMethods", () => router.allowedMethods("/tasks/42"));
measure("route 405 lookup", () =>
  router.allowedMethods("/tasks/42").join(", "),
);
