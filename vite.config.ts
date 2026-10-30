import { defineConfig,loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The UI talks to ComfyUI through this proxy, so the browser never makes a
// cross-origin request. COMFY_URL can point at another machine on the LAN.
const comfyUrl = process.env.COMFY_URL ?? "http://127.0.0.1:8188";

export default defineConfig(({mode})=>{
const teamMode=loadEnv(mode,process.cwd(),"VITE_").VITE_TEAM_MODE==="1"||process.env.VITE_TEAM_MODE==="1";
return {
  // Open editor tabs may still lazy-load chunks from the previous build.
  // Keep hashed assets; a fresh checkout remains the clean release-build path.
  build:{emptyOutDir:false},
  plugins: [
    react(),
    {
      // Something in this AppData folder briefly locks files (EBUSY) while they
      // are saved. Without a listener, the watcher error kills the dev server.
      name: "tolerate-watch-errors",
      configureServer(server) {
        server.watcher.on("error", (err) => server.config.logger.warn(`watcher: ${(err as Error).message}`));
      },
    },
  ],
  server: {
    host:"127.0.0.1",
    proxy: {
      "/api":{target:process.env.TEAM_API_URL??"http://127.0.0.1:8787",changeOrigin:false},
      ...(!teamMode?{"/comfy": {
        target: comfyUrl,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/comfy/, ""),
        configure: (proxy) => {
          // ComfyUI answers 403 when a loopback request's Origin host differs from its Host
          // header (its DNS-rebinding guard). Browsers send Origin on WebSockets and POSTs, so
          // the proxy presents ComfyUI's own origin. This keeps ComfyUI's protection switched
          // on, instead of starting it with --enable-cors-header.
          const origin = new URL(comfyUrl).origin;
          proxy.on("proxyReq", (req) => req.setHeader("Origin", origin));
          proxy.on("proxyReqWs", (req, _req, socket) => {
            req.setHeader("Origin", origin);
            // A browser tab closing mid-handshake aborts this socket. Without a listener Node treats it as fatal.
            socket.on("error", () => {});
          });
          // ComfyUI may be stopped. A refused connection must not take the dev server down.
          proxy.on("error", (_err, _req, res) => {
            const target = res as { writeHead?: (code: number) => void; headersSent?: boolean; end?: () => void; destroy?: () => void } | undefined;
            if (target?.writeHead && !target.headersSent) target.writeHead(502);
            if (target?.end) target.end();
            else target?.destroy?.();
          });
        },
      }}:{}),
    },
  },
};});
