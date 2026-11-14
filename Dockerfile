# CreativeField try-out image for Railway (or any container host). No GPU: the app, the library and FotoField
# run here; generating needs a ComfyUI worker, which you add later under Team settings -> Workers.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY workflow-candidates/controlfoley-video-sound.api.json ./workflow-candidates/
COPY native-workflows ./native-workflows
COPY pipelines ./pipelines
COPY public ./public
COPY scripts ./scripts
COPY fixtures ./fixtures
RUN npm run build
ENV NODE_ENV=production COMFYFIELD_PUBLIC_TRYOUT=1 SERVE_UI=1 UI_ROOT=dist HOST=0.0.0.0 STORAGE_ROOT=/data
EXPOSE 8080
CMD ["node", "scripts/railway-start.mjs"]
