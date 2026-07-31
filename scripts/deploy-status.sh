#!/usr/bin/env bash
# When did each half of yeschef-llm last deploy? Orchestrator = newest /ai Cloud Run revision;
# workers = newest MIG instance-template per model. Read-only. Usage: npm run deploy:status
set -euo pipefail
PROJECT="${GCP_PROJECT_ID:-yeschef-c572a}"
REGION="${AI_REGION:-us-central1}"

echo "=== ORCHESTRATOR (/ai Cloud Run) — project $PROJECT ==="
gcloud run revisions list --service=ai --region="$REGION" --project="$PROJECT" \
  --sort-by="~metadata.creationTimestamp" --limit=1 \
  --format="table(metadata.name, metadata.creationTimestamp)" 2>/dev/null

echo ""
echo "=== WORKERS (MIG instance templates, newest first) ==="
gcloud compute instance-templates list --project="$PROJECT" \
  --sort-by="~creationTimestamp" \
  --format="table(name, creationTimestamp)" 2>/dev/null | head -12
