# Ollama Infrastructure - GCP LLM Deployment

AI-powered inference via Ollama, Pub/Sub messaging, and MongoDB RAG.

## Prerequisites

**All explicitly listed — no hidden dependencies.**

- **Node.js** ≥ 22
- **Firebase CLI** — `npm install -g firebase-tools`
- **Ollama** — `curl -fsSL https://ollama.com/install.sh | sh`

## Setup

```bash
npm install                # Install dependencies
npm run setup              # Verify all prerequisites installed
npm run dev                # Start local development
```

## Development

```bash
npm run dev                # Firebase emulator + Ollama + worker
                           # - Emulator UI: http://localhost:4000
                           # - Ollama: http://localhost:11434
                           # - Pub/Sub auto-created for testing
```

Test with:
```bash
gcloud pubsub topics publish llama3_2_3b_v1 \
  --message='{"jobId":"test-1","query":"List foods safe for a diabetic diet"}' \
  --project=demo-ollama
```

## Production

```bash
npm run deploy:prod        # Build Docker images, push to GCR, deploy to Cloud Run
npm run rollback:prod      # Roll back to previous revision
```

Requires:
- GCP project with Artifact Registry + Cloud Run enabled
- Service account key at `GOOGLE_APPLICATION_CREDENTIALS` path in `.env.production`

## Architecture

```
Client → Pub/Sub topic → worker/index.js → MongoDB Atlas (RAG) → Ollama → Result
```

**Two model tiers:**

| Topic | Model | GPUs |
|-------|-------|------|
| `llama3_2_3b_v1` | Llama 3.2 3B | 1× L4 |
| `llama3_3_70b_v1` | Llama 3.3 70B | 2× L4 |

Same `worker/index.js` runs both — configured entirely via env vars.

## Environment Variables

See `.env.dev` (local) and `.env.production` (prod). Layering via `dotenv-flow`:
- `.env` → `.env.dev` / `.env.production`

| Variable | Purpose |
|----------|---------|
| `GCP_PROJECT_ID` | GCP project |
| `MONGO_URI` | MongoDB connection |
| `MONGO_DB` | Database name |
| `MONGO_COLLECTION` | Regulations collection |
| `OLLAMA_MODEL` | Model to load |
| `OLLAMA_NUM_PARALLEL` | Concurrency (2 for single GPU) |
