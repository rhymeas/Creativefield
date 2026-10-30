import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export type LocalComfyStartResult = { state: "launch_requested" | "already_starting" };
export type LocalComfyStarter = (origin: string) => Promise<LocalComfyStartResult>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The bundled launcher is deliberately limited to the one local worker it starts. */
export function managedLocalComfyOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname) && (url.port || "80") === "8188";
  } catch {
    return false;
  }
}

export function createLocalComfyStarter(options: {
  root?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  launch?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
} = {}): LocalComfyStarter {
  const root = options.root ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const launch = options.launch ?? spawn;
  let lastLaunch = 0;

  return async origin => {
    if (!managedLocalComfyOrigin(origin)) throw new Error("The managed starter only supports the local ComfyUI worker at 127.0.0.1:8188.");
    if (platform !== "win32") throw new Error("Start ComfyUI on this computer, then check the worker again.");
    const current = now();
    if (lastLaunch && current - lastLaunch < 30_000) return { state: "already_starting" };

    const script = path.resolve(root, "scripts", "start-comfy.bat");
    await access(script);
    const command = process.env.ComSpec ?? "cmd.exe";
    await new Promise<void>((resolve, reject) => {
      const child = launch(command, ["/d", "/s", "/c", script], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    lastLaunch = current;
    return { state: "launch_requested" };
  };
}

export const startLocalComfy = createLocalComfyStarter();
