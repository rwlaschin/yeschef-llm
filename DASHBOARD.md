# YesChef LLM Testing Dashboard

## Quick Start

The dashboard is a local Nuxt app for testing Ollama inference without deploying to production.

### Prerequisites

Before starting the dashboard, ensure the main dev environment is running:

```bash
# Terminal 1: Start LLM infrastructure (Ollama + Pub/Sub + Worker)
cd /Users/mac/Documents/Work/alimenta/yeschef-llm
npm run dev
```

Wait for: `=== Dev environment ready ===`

### Run Dashboard

```bash
# Terminal 2: Start dashboard
cd /Users/mac/Documents/Work/alimenta/yeschef-llm/dashboard
npm install
npm run dev
```

Visit: **http://localhost:3000**

## Features

1. **Glass Morphism UI**
   - Modern frosted glass design with backdrop blur
   - Smooth hover effects and transitions
   - Professional, minimal aesthetic

2. **Dark/Light Mode**
   - Toggle with button in header
   - Persists to localStorage (key: `yeschef-llm-theme`)
   - Defaults to dark mode
   - Full theme support across all components

3. **Activity Logging (Pino)**
   - All dashboard events logged via Pino
   - Logs stored in browser localStorage (key: `yeschef-llm-logs`)
   - Activity panel shows last 100 logs
   - Timestamps, log levels (TRACE, DEBUG, INFO, WARN, ERROR)
   - Persistent across sessions

4. **Configuration Panel**
   - Switch between local/production
   - Check connection status (MongoDB, Pub/Sub, Ollama)

5. **Pub/Sub Publisher**
   - Select model (Slim 2B or Large 70B)
   - Enter query
   - Auto-generated job ID for tracking
   - Publishes to appropriate topic

6. **Real-time Results Viewer**
   - Listens to MongoDB `results` collection via change streams
   - Shows query, answer, status, latency
   - Auto-updates as worker processes messages

7. **External Tools**
   - **MongoDB Compass** — inspect `results` collection
   - **Neo4j Browser** — query relationships
   - **Firebase Console** — view Firestore, Pub/Sub
   - **Emulator UI** (local) — Firebase Pub/Sub emulator
   - **Ollama Server** (local) — model info

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot connect to MongoDB" | Check `.env.dev` has correct MONGO_URI |
| "Pub/Sub emulator not found" | Ensure `npm run dev` is running in parent |
| "No results appearing" | Check worker is running; inspect MongoDB directly |
| "Ollama offline" | Run `ollama serve` separately or restart `npm run dev` |

## File Structure

```
dashboard/
├── pages/index.vue                  # Main dashboard
├── components/
│   ├── ConfigPanel.vue              # Environment + health checks
│   ├── PubSubPublisher.vue          # Message publisher
│   ├── ResultsViewer.vue            # Real-time results
│   ├── ExternalTools.vue            # Tool links
│   └── LogsViewer.vue               # Activity logs panel
├── composables/
│   ├── useTheme.ts                  # Dark/light mode toggle
│   └── useLogger.ts                 # Pino logging with localStorage
├── server/api/
│   ├── pubsub/publish.post.ts       # Publish API
│   ├── results/stream.get.ts        # SSE stream
│   └── health/*.get.ts              # Health checks
├── assets/css/main.css              # Glass morphism styles
├── nuxt.config.ts                   # Nuxt config with color-mode
├── tailwind.config.js               # Tailwind with glass colors
└── README.md
```

## Next Steps

1. Start the dev environment: `npm run dev` (parent dir)
2. Wait for "Dev environment ready"
3. Start the dashboard: `npm run dev` (in dashboard/ dir)
4. Open http://localhost:3000
5. Publish a test query and watch the results appear in real-time

Happy testing! 🧪
