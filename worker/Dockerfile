# Worker do VideoAI Studio (FFmpeg + provedores de IA).
# Contexto de build: raiz do repositório →  docker build -f worker/Dockerfile -t videoai-worker .
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY worker/package.json worker/package-lock.json worker/
RUN cd worker && npm ci
COPY shared shared
COPY worker worker
RUN cd worker && npm run build && npm prune --omit=dev
ENV NODE_ENV=production WORKER_TMP_DIR=/tmp/videoai-worker
USER node
CMD ["node", "worker/dist/index.js"]
