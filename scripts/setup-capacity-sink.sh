#!/usr/bin/env bash
# One-time infra for the capacity recorder's auto-trigger: a Cloud Logging sink that routes completed
# ollama worker create operations (success AND ZONE_RESOURCE_POOL_EXHAUSTED) to a Pub/Sub topic the
# `capacityRecorder` function (functions/index.js) subscribes to. Idempotent — safe to re-run.
#
# Deploy the function first (npm run deploy:orchestrator) so the topic `capacity_create_events` exists,
# then run this once. Re-run only if the filter or topic changes.
set -u
PROJECT="${GCP_PROJECT_ID:-yeschef-c572a}"
TOPIC="capacity_create_events"
SINK="capacity-create-sink"
TOPIC_PATH="pubsub.googleapis.com/projects/${PROJECT}/topics/${TOPIC}"
# Completed worker-create operations only (operation.last), any outcome. store.js/recorder classify
# success vs failure from status.message.
FILTER='protoPayload.methodName="v1.compute.instances.insert" AND protoPayload.resourceName:"-mig-" AND operation.last=true'

# Ensure the topic exists (the function also declares it on deploy; create here so the sink can bind).
gcloud pubsub topics create "$TOPIC" --project="$PROJECT" 2>/dev/null || true

# Create or update the sink.
if gcloud logging sinks describe "$SINK" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud logging sinks update "$SINK" "$TOPIC_PATH" --project="$PROJECT" --log-filter="$FILTER"
else
  gcloud logging sinks create "$SINK" "$TOPIC_PATH" --project="$PROJECT" --log-filter="$FILTER"
fi

# Grant the sink's writer identity permission to publish to the topic (required, else logs are dropped).
WRITER=$(gcloud logging sinks describe "$SINK" --project="$PROJECT" --format="value(writerIdentity)")
echo "Sink writer identity: $WRITER"
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT" \
  --member="$WRITER" --role="roles/pubsub.publisher" >/dev/null
echo "Done. Sink '$SINK' → topic '$TOPIC' → capacityRecorder. Recorder will now log ok/fail on real creates."
