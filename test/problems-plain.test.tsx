import {readFileSync} from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {Notice} from "../src/ds";
import {folderProblem,libraryProblem,looksTechnical,plainAlready,plainProblem,plainReasons,workerBlocker} from "../src/team/problems";
import type {Worker} from "../src/team/api";

/* every failure a person can meet says what happened in everyday words and offers one
   action. The raw text (a code, an address, a stack frame) waits behind Details for support. */

const raw = [
  "object_info:request_failed",
  "models:request_failed",
  "models/loras:request_failed",
  "object_info:invalid_response",
  "models:invalid_response",
  "Request failed (500)",
  "Request failed (403)",
  "Workspace permission required",
  "Capability not found",
  "Team server unavailable. No job is submitted to another service.",
  "fetch failed",
  "connect ECONNREFUSED 127.0.0.1:8188",
  "getaddrinfo ENOTFOUND comfy.invalid",
  "The worker did not answer in time.",
  "ENOSPC: no space left on device, write",
  "socket hang up",
  "TypeError: Cannot read properties of undefined (reading 'outputs')\n    at run (/public-fixtures/workflow.ts:12:3)",
  "Invalid request",
];

describe("plain language for failures", () => {
  it("says every known code in words, with one action and its own text for support", () => {
    for (const message of raw) {
      const problem = plainProblem(message);
      expect(problem.text.length, message).toBeGreaterThan(12);
      expect(problem.fix.label.length, message).toBeGreaterThan(3);
      if (looksTechnical(message)) expect(problem.details, message).toBeTruthy();
      expect(looksTechnical(`${problem.title} ${problem.text}`), `${message} -> ${problem.title} ${problem.text}`).toBe(false);
    }
  });

  it("leaves a sentence already written for a person alone", () => {
    const sentence = "Choose a project with creator access to save a crop.";
    const problem = plainProblem(sentence);
    expect(problem.text).toBe(sentence);
    expect(problem.title).toBe("");
    expect(problem.details).toBeUndefined();
    expect(plainAlready(sentence)).toBe(true);
    expect(plainAlready("Request failed (500)")).toBe(false);
  });

  it("gives an unknown message a generic sentence and the copyable details", () => {
    const problem = plainProblem("kaboom");
    expect(problem.title).toBe("Something went wrong");
    expect(problem.text).not.toContain("kaboom");
    expect(problem.details).toBe("kaboom");
    expect(problem.fix.kind).toBe("retry");
    expect(looksTechnical(`${problem.title} ${problem.text}`)).toBe(false);
  });

  it("collapses several library reads with one cause into one problem", () => {
    const collapsed = libraryProblem(["object_info:request_failed", "models:request_failed", "models/loras:request_failed"], { address: "127.0.0.1:8188" });
    expect(collapsed).not.toBeNull();
    expect(collapsed!.text).toBe("ComfyUI isn't answering at 127.0.0.1:8188. It may not be running.");
    expect(collapsed!.fix.label).toBe("Start ComfyUI");
    expect(collapsed!.details?.split("\n")).toHaveLength(3);
  });

  it("tells a wrong server apart from a missing one", () => {
    const wrong = libraryProblem(["object_info:invalid_response"], { address: "127.0.0.1:9000" })!;
    expect(wrong.title).toBe("Something else is answering");
    expect(wrong.fix.kind).toBe("open-settings");
    expect(looksTechnical(`${wrong.title} ${wrong.text}`)).toBe(false);
  });

  it("keeps one unread folder a folder problem, not a dead server", () => {
    const folders = libraryProblem(["models/loras:invalid_response"])!;
    expect(folders.text).toContain("loras folder");
    expect(folders.fix.kind).toBe("check-again");
    expect(folderProblem("loras", "request_failed")).not.toMatch(/request_failed/);
    expect(folderProblem("loras", "invalid_response")).not.toMatch(/invalid_response/);
    expect(libraryProblem([])).toBeNull();
  });

  it("lets a plain readiness sentence through and rewrites a code that slips in", () => {
    expect(plainReasons(["The selected execution service is not reachable."])).toBe("The selected execution service is not reachable.");
    expect(plainReasons(["object_info:request_failed"])).not.toMatch(/object_info/);
  });
});

describe("the code waits behind Details", () => {
  it("keeps the technical text out of the rendered notice until it is asked for", () => {
    const html = renderToStaticMarkup(<Notice title="ComfyUI isn't answering" details="object_info:request_failed">ComfyUI isn't answering at 127.0.0.1:8188. It may not be running.</Notice>);
    expect(html).toContain("ComfyUI isn&#x27;t answering at 127.0.0.1:8188.");
    expect(html).not.toContain("object_info:request_failed");
    expect(html).toContain("Details");
    expect(readFileSync("src/ds/components.tsx", "utf8")).toContain('copyLabel="Copy details"');
  });
});

/* one cause per screen, in everyday words, carrying the one action that clears it. */
const worker = (over: Partial<Worker> = {}): Worker => ({ id: "w1", name: "This computer", enabled: true, origin: "http://127.0.0.1:8188", checked_at: new Date().toISOString(), inventory: { online: true, nodes: [], models: [], credentials: [] }, ...over });

describe("what stops a run, one cause at a time", () => {
  it("asks for a connection when no worker is registered", () => {
    const blocker = workerBlocker({ workers: [], readiness: null, starting: false, settings: "Settings" })!;
    expect(blocker.cause).toBe("no-worker");
    expect(blocker.text).toBe("CreativeField isn't connected to ComfyUI yet. Add its address in Settings and check it.");
    expect(blocker.fix.label).toBe("Connect ComfyUI");
    expect(blocker.text).not.toMatch(/administrator|admin/i);
  });

  it("offers to start ComfyUI when the worker can be started here", () => {
    const offline = worker({ can_start: true, inventory: { online: false, nodes: [], models: [], credentials: [] } });
    const blocker = workerBlocker({ workers: [offline], worker: offline, offlineWorker: offline, readiness: { state: "offline", reasons: ["The selected execution service is not reachable."], missing: [] }, starting: false })!;
    expect(blocker.cause).toBe("offline");
    expect(blocker.fix.label).toBe("Start ComfyUI");
    expect(looksTechnical(`${blocker.title} ${blocker.text}`)).toBe(false);
  });

  it("asks to check again when this computer cannot start the worker", () => {
    const offline = worker({ can_start: false, inventory: { online: false, nodes: [], models: [], credentials: [] } });
    const blocker = workerBlocker({ workers: [offline], worker: offline, offlineWorker: offline, readiness: { state: "offline", reasons: [], missing: [] }, starting: false })!;
    expect(blocker.fix.kind).toBe("check-again");
    expect(blocker.text).toContain("then check again");
  });

  it("names what is still missing and opens Models", () => {
    const blocker = workerBlocker({ workers: [worker()], worker: worker(), readiness: { state: "download_required", reasons: ["Download the model."], missing: [{ id: "a", kind: "model", name: "wan.safetensors", location: "diffusion_models", instructions: "Put it in diffusion_models." }, { id: "b", kind: "model", name: "vae.safetensors", location: "vae", instructions: "Put it in vae." }, { id: "c", kind: "node", name: "WanVideoSampler", instructions: "Install the node." }] }, starting: false })!;
    expect(blocker.cause).toBe("missing-files");
    expect(blocker.text).toBe("This tool needs 2 models and 1 node before it can run here. Models shows which ones and where they go.");
    expect(blocker.fix.label).toBe("Open Models");
    expect(blocker.details).toContain("wan.safetensors");
  });

  it("offers this computer when a cloud plan cannot run the job", () => {
    const cloud = worker({ id: "c1", kind: "cloud" } as Partial<Worker>);
    const withLocal = workerBlocker({ workers: [cloud], worker: cloud, readiness: { state: "credentials_required", reasons: ["This Comfy Cloud plan does not allow runs from other apps."], missing: [] }, starting: false, canRunLocal: true })!;
    expect(withLocal.cause).toBe("credentials");
    expect(withLocal.fix.label).toBe("Run on this computer");
    expect(withLocal.text).not.toMatch(/credentials_required/);
    const alone = workerBlocker({ workers: [cloud], worker: cloud, readiness: { state: "credentials_required", reasons: [], missing: [] }, starting: false })!;
    expect(alone.fix.kind).toBe("open-settings");
  });

  it("says nothing when the worker is ready, and says it is starting while it starts", () => {
    expect(workerBlocker({ workers: [worker()], worker: worker(), readiness: { state: "ready", reasons: [], missing: [] }, starting: false })).toBeNull();
    const starting = workerBlocker({ workers: [], readiness: null, starting: true })!;
    expect(starting.cause).toBe("starting");
    expect(starting.text).toBe("This model runs as soon as ComfyUI answers.");
  });
});
