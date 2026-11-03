import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { probe, REQUIRED_NODES } from "../src/comfy/probe";

// A tiny fake ComfyUI that answers the probe's calls. `nodes` controls object_info.
function fakeServer(opts: { nodes: string[]; prefix: "/api" | "" }) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    // A "/api" server only answers under /api; a bare server never answers under /api.
    const underApi = path.startsWith("/api/");
    if ((opts.prefix === "/api" && !underApi) || (opts.prefix === "" && underApi)) {
      res.statusCode = 404;
      return res.end();
    }
    const route = path.replace(/^\/api/, "");
    const json = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (route === "/system_stats")
      return json(200, { system: { comfyui_version: "9.9.9" }, devices: [{ name: "cuda:0 Test GPU : x", vram_total: 8 * 1024 ** 3, vram_free: 4 * 1024 ** 3 }] });
    if (route === "/object_info") return json(200, Object.fromEntries(opts.nodes.map((n) => [n, {}])));
    if (["/queue", "/history", "/jobs", "/features"].includes(route)) return json(200, {});
    if (route === "/upload/image") return json(200, { name: "studio-smoke.png", subfolder: "", type: "temp" });
    if (route === "/view") {
      res.setHeader("Content-Type", "image/png");
      return res.end(Buffer.from([1, 2, 3]));
    }
    if (route === "/prompt" && req.method === "POST") return json(400, { error: { type: "missing_node_type" }, node_errors: {} });
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }),
    ),
  );
}

const open: Array<{ close: () => void }> = [];
afterAll(() => open.forEach((s) => s.close()));

describe("probe", () => {
  it("reports unreachable when nothing answers", async () => {
    const report = await probe("http://127.0.0.1:1");
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "reach", ok: false });
  });

  it("detects the /api prefix and lists missing video nodes", async () => {
    const s = await fakeServer({ nodes: ["LoadImage", "KSampler"], prefix: "/api" });
    open.push(s);
    const report = await probe(s.url);
    expect(report.apiPrefix).toBe("/api");
    expect(report.version).toBe("9.9.9");
    expect(report.gpu).toEqual({ name: "Test GPU", vramTotalGB: 8, vramFreeGB: 4 });
    expect(report.missingNodes).toContain("WanImageToVideo");
    expect(report.missingNodes).not.toContain("LoadImage");
    expect(report.ok).toBe(false);
  });

  it("falls back to bare routes on servers without the /api prefix", async () => {
    const s = await fakeServer({ nodes: [...REQUIRED_NODES], prefix: "" });
    open.push(s);
    const report = await probe(s.url);
    expect(report.apiPrefix).toBe("");
    expect(report.missingNodes).toEqual([]);
  });
});
