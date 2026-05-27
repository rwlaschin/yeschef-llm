# ============================================================
# Image 2: Large Model - Llama 3.3 70B Q4
# GPU: 2x NVIDIA L4 (48GB VRAM total)
# Build from project root:
#   docker build -f docker/large/Dockerfile -t ollama-large .
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
COPY docker/large/start.sh /start.sh

RUN npm install && chmod +x /start.sh

# Pull quantized model - fits across 2x L4 (48GB total)
RUN ollama serve & sleep 5 && ollama pull llama3.3:70b-instruct-q4_K_M && pkill ollama || true

ENV OLLAMA_MODEL=llama3.3:70b-instruct-q4_K_M
ENV OLLAMA_HOST=http://localhost:11434
ENV OLLAMA_NUM_PARALLEL=2
ENV OLLAMA_MAX_QUEUE=5
ENV SUBSCRIPTION_NAME=sub_llama3_3_70b_v1
ENV CUDA_VISIBLE_DEVICES=0,1
ENV OLLAMA_SCHED_SPREAD=1

CMD ["/start.sh"]
