import { afterEach, describe, expect, it, vi } from "vitest";
import { loadComfyLibrary } from "../server/comfy-library";

const worker = { id: "w1", name: "Local ComfyUI", origin: "http://127.0.0.1:8188", api_prefix: "/api" };

function routeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const handler = routes[url.pathname];
    if (!handler) return new Response("missing", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("ComfyUI library adapter", () => {
  it("normalizes node classes, all model folders and the server version", async () => {
    const fetch = routeFetch({
      "/api/system_stats": () => Response.json({ system: { comfyui_version: "0.3.60" }, devices: [] }),
      "/api/object_info": () => Response.json({
        KSampler: { display_name: "KSampler", category: "sampling", output: ["LATENT"] },
        LoadImage: { display_name: ["Load Image"], category: "image", output: ["IMAGE", "MASK"] },
      }),
      "/api/models": () => Response.json(["checkpoints", "loras"]),
      "/api/models/checkpoints": () => Response.json(["wan.safetensors", "sdxl.safetensors"]),
      "/api/models/loras": () => Response.json(["style.safetensors"]),
    });
    const library = await loadComfyLibrary(worker, fetch);
    expect(library).toMatchObject({ online: true, version: "0.3.60", workerId: "w1", workerName: "Local ComfyUI" });
    expect(library.nodes.map(node => node.name)).toEqual(["LoadImage", "KSampler"]);
    expect(library.nodes[0]).toEqual({ name: "LoadImage", displayName: "Load Image", category: "image", outputs: ["IMAGE", "MASK"] });
    expect(library.folders).toEqual([
      { name: "checkpoints", files: ["sdxl.safetensors", "wan.safetensors"] },
      { name: "loras", files: ["style.safetensors"] },
    ]);
    expect(library.issues).toEqual([]);
    expect(JSON.stringify(library)).not.toContain(worker.origin);
  });

  it("keeps the library online when one model folder cannot be read", async () => {
    const fetch = routeFetch({
      "/api/system_stats": () => Response.json({}),
      "/api/object_info": () => Response.json({ KSampler: {} }),
      "/api/models": () => Response.json(["checkpoints", "vae"]),
      "/api/models/checkpoints": () => Response.json(["wan.safetensors"]),
      "/api/models/vae": () => new Response("down", { status: 503 }),
    });
    const library = await loadComfyLibrary(worker, fetch);
    expect(library.online).toBe(true);
    expect(library.folders).toEqual([
      { name: "checkpoints", files: ["wan.safetensors"] },
      { name: "vae", files: [], error: "request_failed" },
    ]);
    expect(library.issues).toEqual(["models/vae:request_failed"]);
  });

  it("fails closed on malformed object info without reading model folders", async () => {
    const fetch = routeFetch({
      "/api/system_stats": () => Response.json({}),
      "/api/object_info": () => Response.json([]),
    });
    const library = await loadComfyLibrary(worker, fetch);
    expect(library).toMatchObject({ online: false, nodes: [], folders: [], version: null });
    expect(library.issues).toEqual(["object_info:invalid_response"]);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]))).not.toContain(`${worker.origin}/api/models`);
  });

  it("reports an unusable folder listing without dropping node classes", async () => {
    const fetch = routeFetch({
      "/api/system_stats": () => Response.json({ system: { comfyui_version: "0.3.60" } }),
      "/api/object_info": () => Response.json({ KSampler: {} }),
      "/api/models": () => Response.json({ checkpoints: [] }),
    });
    const library = await loadComfyLibrary(worker, fetch);
    expect(library.online).toBe(true);
    expect(library.nodes).toHaveLength(1);
    expect(library.folders).toEqual([]);
    expect(library.issues).toEqual(["models:invalid_response"]);
  });

  it("reports an unreachable server without throwing", async () => {
    const offlineFetch: typeof globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof globalThis.fetch;
    const library = await loadComfyLibrary(worker, offlineFetch);
    expect(library).toMatchObject({ online: false, nodes: [], folders: [] });
    expect(library.issues).toEqual(["object_info:request_failed"]);
  });
});
