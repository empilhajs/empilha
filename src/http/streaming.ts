export type SseEvent = {
  data: string | unknown;
  event?: string;
  id?: string;
  retry?: number;
};

export type SseSource =
  | AsyncIterable<SseEvent | string>
  | Iterable<SseEvent | string>
  | ReadableStream<SseEvent | string>;

function encodeEvent(value: SseEvent | string): string {
  if (typeof value === "string") return `data: ${value}\n\n`;
  const lines = [`${value.event ? `event: ${value.event}\n` : ""}`];
  if (value.id !== undefined) lines.push(`id: ${value.id}\n`);
  if (value.retry !== undefined) lines.push(`retry: ${value.retry}\n`);
  const data =
    typeof value.data === "string" ? value.data : JSON.stringify(value.data);
  for (const line of data.split("\n")) lines.push(`data: ${line}\n`);
  lines.push("\n");
  return lines.join("");
}

/** Cria uma resposta Server-Sent Events a partir de um iterável ou stream. */
export function sse(source: SseSource, init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (source instanceof ReadableStream) {
          const reader = source.getReader();
          try {
            while (true) {
              const item = await reader.read();
              if (item.done) break;
              controller.enqueue(
                new TextEncoder().encode(encodeEvent(item.value)),
              );
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          for await (const value of source) {
            controller.enqueue(new TextEncoder().encode(encodeEvent(value)));
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");
  return new Response(stream, { ...init, headers });
}

export type WebSocketUpgradeServer = {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
};

/** Usa o upgrade nativo do Bun e retorna `undefined` quando ele foi aceito. */
export function upgradeWebSocket(
  request: Request,
  server: WebSocketUpgradeServer,
  data?: unknown,
): Response | undefined {
  if (server.upgrade(request, { data })) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}
