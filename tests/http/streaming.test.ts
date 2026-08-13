import { describe, expect, test } from "bun:test";
import { sse, upgradeWebSocket } from "../../src/http";

describe("streaming helpers", () => {
  test("serializa eventos SSE e configura headers", async () => {
    const response = sse([
      { event: "message", id: "1", data: { ok: true } },
      "done",
    ]);

    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(await response.text()).toBe(
      'event: message\nid: 1\ndata: {"ok":true}\n\ndata: done\n\n',
    );
  });

  test("encaminha upgrade WebSocket ao servidor Bun", () => {
    let received: Request | undefined;
    const accepted = upgradeWebSocket(
      new Request("http://localhost/socket"),
      {
        upgrade(request) {
          received = request;
          return true;
        },
      },
      { userId: "1" },
    );

    expect(accepted).toBeUndefined();
    expect(received?.url).toContain("/socket");
  });

  test("retorna 400 quando o upgrade é rejeitado", () => {
    const response = upgradeWebSocket(new Request("http://localhost/socket"), {
      upgrade: () => false,
    });

    expect(response?.status).toBe(400);
  });
});
