#!/bin/sh
# Start Ollama server in background, then start the Node worker

ollama serve &
OLLAMA_PID=$!

echo "Waiting for Ollama..."
until curl -sf http://localhost:11434/api/tags > /dev/null; do
  sleep 1
done
echo "Ollama ready (2x L4 - 48GB VRAM)"

node worker/index.js &
WORKER_PID=$!

wait -n $OLLAMA_PID $WORKER_PID
kill $OLLAMA_PID $WORKER_PID 2>/dev/null
