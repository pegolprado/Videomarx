# Worker do VideoAI Studio (FFmpeg + motor próprio + modelos animados + provedores de IA).
# Contexto de build: raiz do repositório →  docker build -f worker/Dockerfile -t videoai-worker .
#
# Motor próprio (roda na CPU, sem custo por uso):
#   - Whisper via whisper.cpp (MIT) + modelo multilíngue da OpenAI (MIT) → legendas automáticas
#   - Piper (MIT) + vozes em português (licença de cada voz: ver docs/MOTOR_PROPRIO.md) → voz
#   - HyperFrames (Apache 2.0) + Chromium → modelos animados (texto e imagens → vídeo)
# As etapas abaixo não dependem do código do app: o Docker as reaproveita entre atualizações.

# ---- Whisper (compilado uma vez) -------------------------------------------
FROM node:22-bookworm-slim AS whisper
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ARG WHISPER_VERSION=v1.9.5
RUN git clone --depth 1 -b ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /build -j"$(nproc)" --target whisper-cli \
 && cp /build/bin/whisper-cli /usr/local/bin/whisper-cli \
 && rm -rf /src /build
# base = leve (servidor pequeno). Em máquina maior use small: --build-arg WHISPER_MODEL=small
ARG WHISPER_MODEL=base
RUN mkdir -p /models \
 && curl -fsSL -o /models/whisper.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"

# ---- Piper (binário oficial + vozes) ----------------------------------------
FROM node:22-bookworm-slim AS piper
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ARG PIPER_VERSION=2023.11.14-2
RUN curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_$(uname -m).tar.gz" | tar -xz -C /opt
# vozes: idioma_PAÍS-nome-qualidade (a primeira é obrigatória; as demais, se existirem)
ARG PIPER_VOICES="pt_BR-faber-medium"
RUN mkdir -p /voices && first=1 && for v in ${PIPER_VOICES}; do \
      locale="${v%%-*}"; lang="${locale%%_*}"; rest="${v#*-}"; name="${rest%-*}"; quality="${rest##*-}"; \
      base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${locale}/${name}/${quality}/${v}"; \
      if curl -fsSL -o "/voices/${v}.onnx" "${base}.onnx" && curl -fsSL -o "/voices/${v}.onnx.json" "${base}.onnx.json"; then :; \
      elif [ "$first" = 1 ]; then echo "voz obrigatória indisponível: $v" >&2; exit 1; \
      else echo "aviso: voz $v indisponível" >&2; rm -f "/voices/${v}.onnx" "/voices/${v}.onnx.json"; fi; \
      first=0; done

# ---- Worker ----------------------------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates libgomp1 \
      chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models /models
COPY --from=piper /opt/piper /opt/piper
COPY --from=piper /voices /voices
WORKDIR /app
COPY worker/package.json worker/package-lock.json worker/
RUN cd worker && npm ci
COPY shared shared
COPY worker worker
RUN cd worker && npm run build && npm prune --omit=dev
ENV NODE_ENV=production WORKER_TMP_DIR=/tmp/videoai-worker LOCAL_AI_THREADS=2 \
    HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_SKIP_SKILLS=1
USER node
CMD ["node", "worker/dist/index.js"]
