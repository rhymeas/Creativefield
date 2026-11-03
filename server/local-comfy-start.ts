import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export type LocalComfyStartResult = { state: "launch_requested" | "already_starting" };
export type LocalComfyStarter = (origin: string) => Promise<LocalComfyStartResult>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The managed launcher is limited to one explicitly configured loopback origin. */
export function managedLocalComfyOrigin(origin: string, env:NodeJS.ProcessEnv=process.env): boolean {
  try {
    const url = new URL(origin);
    const configured=new URL(env.COMFYFIELD_COMFY_ORIGIN?.trim() || "http://127.0.0.1:8188");
    return url.protocol === "http:" && configured.protocol === "http:" && LOOPBACK.has(url.hostname) && LOOPBACK.has(configured.hostname) && !url.username && !url.password && !configured.username && !configured.password && url.pathname === "/" && configured.pathname === "/" && !url.search && !url.hash && !configured.search && !configured.hash && (url.port || "80") === (configured.port || "80");
  } catch {
    return false;
  }
}

export function createLocalComfyStarter(options: {
  root?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  launch?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  env?: NodeJS.ProcessEnv;
} = {}): LocalComfyStarter {
  const root = options.root ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const launch = options.launch ?? spawn;
  const env = options.env ?? process.env;
  let lastLaunch = 0;

  return async origin => {
    if (!managedLocalComfyOrigin(origin,env)) throw new Error("The managed starter only supports the configured local ComfyUI worker.");
    if (platform !== "win32") throw new Error("Start ComfyUI on this computer, then check the worker again.");
    const current = now();
    if (lastLaunch && current - lastLaunch < 30_000) return { state: "already_starting" };

    const script = path.resolve(env.COMFYFIELD_COMFY_START_SCRIPT?.trim() || path.join(root, "scripts", "start-comfy.bat"));
    // cmd.exe interprets these characters even inside quotes. A local operator
    // may choose a script, but never inject extra shell commands through its path.
    if(/["%&|<>^!\r\n]/.test(script) || !/\.(?:bat|cmd)$/i.test(script))throw new Error("Invalid local ComfyUI startup script path.");
    await access(script);
    const command = process.env.ComSpec ?? "cmd.exe";
    await new Promise<void>((resolve, reject) => {
      const child = launch(command, ["/d", "/s", "/c", script.includes(" ")?`"${script}"`:script], {
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
