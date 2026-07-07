# YesChef LLM Dashboard

Local testing interface for Ollama LLM inference via Pub/Sub and MongoDB.

## Features

✅ **Glass Morphism UI** — Modern frosted glass design with Tailwind CSS  
✅ **Dark/Light Mode** — Toggle theme with localStorage persistence  
✅ **Pino Logging** — Activity logs stored in browser localStorage  
✅ **Environment Switching** — Toggle between local dev and production  
✅ **Pub/Sub Publisher** — Send test queries to Ollama workers  
✅ **Real-time Results** — Watch responses stream in via MongoDB change streams  
✅ **Health Checks** — Monitor connections to all services  
✅ **External Tools** — Quick links to MongoDB Compass, Neo4j Browser, Firebase Console  

## Setup

```bash
# Install dependencies
npm install

# Copy environment (uses parent .env by default)
cp .env.example .env

# Start dev server
npm run dev
```

Visit `http://localhost:3000`

## Requirements

Before starting the dashboard, ensure these are running:

```bash
# In parent directory (yeschef-llm/)
npm run dev  # Starts Ollama, Pub/Sub emulator, and worker
```

This gives you:
- ✅ Ollama on `localhost:11434`
- ✅ Pub/Sub emulator on `localhost:8185`
- ✅ MongoDB Atlas connection (in `.env.dev`)
- ✅ Worker listening on subscriptions

## How to Use

### 1. Select Environment

- **Local Dev** — Uses Firebase Pub/Sub emulator + local Ollama
- **Production** — Uses real GCP Pub/Sub + Cloud Run (requires credentials)

### 2. Publish a Query

1. Select a model (Slim 2B or Large 70B)
2. Enter a query (e.g., "List foods safe for a diabetic diet")
3. Click "Publish"
4. The dashboard auto-generates a Job ID for tracking

### 3. Watch Results

Results appear in real-time as the worker processes them:
- **Query** — What you asked
- **Status** — pending → success/error
- **Answer** — Response from Ollama
- **Latency** — How long it took

### 4. Inspect Data

Use external tools to dig deeper:
- **MongoDB Compass** — Browse `results` collection, see all job details
- **Neo4j Browser** — Query graph relationships (regulations, allergens, etc.)
- **Firebase Console** — View Firestore, Storage, Auth

## Architecture

```
Dashboard (Nuxt)
├── Publishes messages to Pub/Sub
├── Listens to MongoDB results via change streams (SSE)
├── Shows real-time status + responses
└── Links to external DB tools
```

## Troubleshooting

**"MongoDB connection failed"**
- Check that `npm run dev` in parent directory is running
- Verify MongoDB URI in `.env.dev`

**"Pub/Sub connection failed"**
- Ensure Firebase emulator is running: `firebase emulators:start --only=pubsub`
- Check `PUBSUB_EMULATOR_HOST=localhost:8185`

**"No results appearing"**
- Check that the worker is running: `npm run dev`
- Verify the job ID matches in MongoDB
- Check worker logs for errors

## Development

```bash
npm run dev        # Start dev server with HMR
npm run build      # Build for production
npm run preview    # Preview build locally
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `MONGO_URI` | MongoDB connection string |
| `MONGO_DB` | Database name (yeschef_dev) |
| `GCP_PROJECT_ID` | Google Cloud project |
| `PUBSUB_EMULATOR_HOST` | Pub/Sub emulator address |
| `NODE_ENV` | development / production |

These are inherited from parent `.env.dev` and `.env.production`.
