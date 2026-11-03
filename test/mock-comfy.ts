// A small stand-in for a ComfyUI server, used only by tests.
// It accepts a graph, sends the same WebSocket events a real run sends,
// and serves a fake output file through /history and /view.

import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type MockComfy = {
  url: string;
  lastGraph: () => Record<string, unknown> | undefined;
  close: () => Promise<void>;
};

export async function startMockComfy(opts: { outputNode: string }): Promise<MockComfy> {
  const sockets = new Map<string, WebSocket>();
  const history = new Map<string, unknown>();
  let lastGraph: Record<string, unknown> | undefined;
  let counter = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // The real server answers on /api/... and on the bare paths; the mock accepts both.
    url.pathname = url.pathname.replace(/^\/api(?=\/)/, "");
    let body = "";
    // Busboy narrows Readable's type declarations. Retain Readable.on at runtime
    // so subscribing to data still starts the request stream flowing.
    const events = req as unknown as EventEmitter;
    events.on("data", (c: Buffer) => (body += c));
    events.on("end", () => {
      if (req.method === "POST" && url.pathname === "/upload/image") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ name: "upload.png", subfolder: "", type: "input" }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/object_info/")) {
        const cls = decodeURIComponent(url.pathname.slice("/object_info/".length));
        res.setHeader("Content-Type", "application/json");
        // "Missing*" classes behave like classes the server does not have: an empty object.
        res.end(JSON.stringify(cls.startsWith("Missing") ? {} : { [cls]: { input: { required: {} }, input_order: { required: [] } } }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/prompt") {
        const parsed = JSON.parse(body) as { prompt: Record<string, { class_type: string }>; client_id: string };
        const rejected = Object.entries(parsed.prompt).find(([, n]) => n.class_type === "RejectMe");
        if (rejected) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "", extra_info: {} },
              node_errors: {
                [rejected[0]]: {
                  class_type: "RejectMe",
                  errors: [{ type: "required_input_missing", message: "Required input is missing", details: "text", extra_info: { input_name: "text" } }],
                  dependent_outputs: [rejected[0]],
                },
              },
            }),
          );
          return;
        }
        lastGraph = parsed.prompt;
        const promptId = `mock-${++counter}`;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ prompt_id: promptId, number: counter, node_errors: {} }));
        runJob(promptId, parsed.client_id);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/history/")) {
        const id = url.pathname.slice("/history/".length);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(history.has(id) ? { [id]: history.get(id) } : {}));
        return;
      }
      if (req.method === "GET" && url.pathname === "/view") {
        res.setHeader("Content-Type", "video/mp4");
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      if (req.method === "POST" && url.pathname === "/interrupt") {
        res.end("{}");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const id = new URL(req.url ?? "/", "http://x").searchParams.get("clientId") ?? "";
    sockets.set(id, ws);
    ws.on("close", () => sockets.delete(id));
  });

  function send(clientId: string, type: string, data: Record<string, unknown>) {
    const ws = sockets.get(clientId);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
  }

  // Emits the event sequence in order with a small delay between steps.
  function runJob(promptId: string, clientId: string) {
    const steps: Array<() => void> = [
      () => send(clientId, "execution_start", { prompt_id: promptId }),
      () => send(clientId, "executing", { node: "5", prompt_id: promptId }),
      () => send(clientId, "progress", { value: 1, max: 4, node: "5", prompt_id: promptId }),
      () => send(clientId, "progress", { value: 4, max: 4, node: "5", prompt_id: promptId }),
      () => send(clientId, "executing", { node: opts.outputNode, prompt_id: promptId }),
      () => {
        const output = { videos: [{ filename: "out_00001.mp4", subfolder: "video", type: "output" }] };
        history.set(promptId, {
          prompt: lastGraph,
          outputs: { [opts.outputNode]: output },
          status: { status_str: "success", completed: true, messages: [] },
        });
        send(clientId, "executed", { node: opts.outputNode, output, prompt_id: promptId });
      },
      () => send(clientId, "executing", { node: null, prompt_id: promptId }),
    ];
    steps.forEach((step, i) => setTimeout(step, 20 * (i + 1)));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    lastGraph: () => lastGraph,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
