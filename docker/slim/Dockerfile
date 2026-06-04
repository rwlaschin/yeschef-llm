# ============================================================
# Image 1: Slim Model - Llama 3.2 2B
# GPU: 1x NVIDIA L4 (24GB VRAM)
# Build from project root:
#   docker build -f docker/slim/Dockerfile -t ollama-slim .
# ============================================================

FROM ollama/ollama:latest

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean

WORKDIR /app

# Copy from project root
COPY package.json ./
COPY worker/ ./worker/
COPY docker/slim/start.sh /start.sh

RUN npm install && chmod +x /start.sh

# Pull model at build time - baked into image, no cold-start pull
RUN ollama serve & \
    sleep 10 && \
    for i in {1..30}; do \
      curl -sf http://localhost:11434/api/tags >/dev/null && break || sleep 2; \
    done && \
    ollama pull llama3.2:2b && \
    pkill -f "ollama serve" || true && \
    sleep 2

ENV OLLAMA_MODEL=llama3.2:2b
ENV OLLAMA_HOST=http://localhost:11434
ENV OLLAMA_NUM_PARALLEL=2
ENV OLLAMA_MAX_QUEUE=5
ENV SUBSCRIPTION_NAME=sub_llama3_2b_v1

CMD ["/start.sh"]
