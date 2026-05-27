#!/bin/sh
# Start Ollama server in background, then start the Node worker

ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready
echo "Waiting for Ollama..."
until curl -sf http://localhost:11434/api/tags > /dev/null; do
  sleep 1
done
echo "Ollama ready"

# Start worker
node worker/index.js &
WORKER_PID=$!

# If either process dies, kill both and exit
wait -n $OLLAMA_PID $WORKER_PID
kill $OLLAMA_PID $WORKER_PID 2>/dev/null
