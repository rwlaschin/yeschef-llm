#!/bin/sh
# Start Ollama, then run the worker in the FOREGROUND so the container lives exactly
# as long as the worker. For OpenClaw gateway tiers (GATEWAY=openclaw), bring up the
# OpenClaw gateway in front of the model first. (POSIX /bin/sh has no `wait -n`.)

ollama serve &

echo "Waiting for Ollama..."
until curl -sf http://localhost:11434/api/tags > /dev/null; do
  sleep 1
done
echo "Ollama ready"

if [ "$GATEWAY" = "openclaw" ]; then
  : "${OPENCLAW_GATEWAY_TOKEN:=openclaw-dev-token}"

  # Onboard OpenClaw against the local Ollama model once (writes ~/.openclaw/openclaw.json).
  # openclaw is baked into the image, so this only configures (no ~82MB download).
  if [ ! -f /root/.openclaw/openclaw.json ]; then
    echo "Onboarding OpenClaw with $OLLAMA_MODEL..."
    ollama launch openclaw --model "$OLLAMA_MODEL" --yes >/tmp/openclaw-onboard.log 2>&1 &
    until [ -f /root/.openclaw/openclaw.json ]; do sleep 1; done
    openclaw gateway stop >/dev/null 2>&1 || true   # stop the launch's gateway; we run our own
    pkill -f "ollama launch openclaw" 2>/dev/null || true
    sleep 1
  fi

  # Patch the OpenClaw config:
  #   - enable the OpenAI-compatible chat-completions endpoint (OFF by default)
  #   - use the FREE Ollama web_search provider (no Brave key): model stays local
  #     (127.0.0.1:11434), web search goes to ollama.com using OLLAMA_API_KEY.
  node -e "const fs=require('fs');const p='/root/.openclaw/openclaw.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.gateway=c.gateway||{};c.gateway.http=c.gateway.http||{};c.gateway.http.endpoints={chatCompletions:{enabled:true}};c.models=c.models||{};c.models.providers=c.models.providers||{};c.models.providers.ollama=Object.assign({baseUrl:'http://127.0.0.1:11434'},c.models.providers.ollama);c.tools=c.tools||{};c.tools.web=c.tools.web||{};c.tools.web.search={enabled:true,provider:'ollama'};c.tools.web.fetch={enabled:true};c.plugins=c.plugins||{};c.plugins.entries=c.plugins.entries||{};c.plugins.entries.ollama=c.plugins.entries.ollama||{};c.plugins.entries.ollama.config=Object.assign({},c.plugins.entries.ollama.config,{webSearch:{baseUrl:'https://ollama.com'}});fs.writeFileSync(p,JSON.stringify(c,null,2));"

  # Run the gateway in the FOREGROUND (container-correct — `openclaw gateway start`
  # needs systemd, which isn't in a container). Backgrounded so the worker runs fg.
  echo "Starting OpenClaw gateway on :18789..."
  openclaw gateway --port 18789 --auth token --token "$OPENCLAW_GATEWAY_TOKEN" --force --allow-unconfigured \
    >/tmp/openclaw-gateway.log 2>&1 &

  echo "Waiting for OpenClaw gateway..."
  until curl -s -o /dev/null http://localhost:18789/ 2>/dev/null; do
    sleep 1
  done
  echo "OpenClaw gateway ready"
fi

exec node worker/index.js
