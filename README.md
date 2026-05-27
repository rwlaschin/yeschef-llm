# Ollama LLM Infrastructure

GCP-based LLM inference using Ollama, Pub/Sub, MongoDB Atlas Vector Search, and Docker.

## Models
| Topic | Model | GPU | Subscription |
|---|---|---|---|
| query_llama3_2b_v1 | Llama 3.2 2B | 1x L4 (24GB) | sub_llama3_2b_v1 |
| query_llama3_3_70b_v1 | Llama 3.3 70B Q4 | 2x L4 (48GB) | sub_llama3_3_70b_v1 |

## Structure
```
ollama-infra/
  pubsub/setup.js        # Create topics and subscriptions
  worker/index.js        # Pub/Sub worker: RAG + Ollama + save result
  scripts/deploy.js      # Build, push, deploy to Cloud Run
  scripts/rollback.js    # Rollback to previous Cloud Run revision
  scripts/dev.js         # Start local dev environment
  docker/slim/           # Image 1: Llama 3.2 2B
  docker/large/          # Image 2: Llama 3.3 70B
  docker-compose.yml     # Local dev: Firebase emulator + Ollama + worker
  .env.example           # Environment variable template
```

## Commands

### Setup
```
npm run setup:pubsub     # Create Pub/Sub topics and subscriptions
```

### Deploy
```
npm run deploy:prod      # Build, push, deploy to production
npm run deploy:test      # Build, push, deploy to test
```

### Rollback
```
npm run rollback:prod    # Rollback production to previous revision
npm run rollback:test    # Rollback test to previous revision
```

### Local Development
```
npm run dev              # Start Firebase emulator + Ollama + worker
```

## Environment Variables
```
cp .env.example .env
# fill in GCP_PROJECT_ID, MONGO_URI, etc.
```

## Message Format (Pub/Sub payload)
```json
{
  "jobId": "unique-job-id",
  "query": "What are the temperature requirements for hot food holding?",
  "metadata": {
    "userId": "optional",
    "facilityId": "optional"
  }
}
```

## Result (saved to MongoDB `results` collection)
```json
{
  "jobId": "unique-job-id",
  "query": "...",
  "answer": "...",
  "model": "llama3.2:2b",
  "subscription": "sub_llama3_2b_v1",
  "createdAt": "2026-01-01T00:00:00Z"
}
```
