#!/usr/bin/env bash
# Emergency kill switch for the worker autoscaler respawn/stockout loop.
#
# Stops autoscaling AND resizes the MIG(s) to 0 across ALL regions, in parallel, so one stuck /
# un-placeable message can't keep spawning boxes against a regional stockout ("1 message → N boxes").
# Regions are HARDCODED on purpose — a kill switch must work even when Mongo / GCP-config is down.
#
# Usage:
#   scripts/kill-workers.sh                 # llama3-1-8b tier (current default)
#   scripts/kill-workers.sh gemma4-12b-v1   # a specific tier by slug (topic with _ → -)
#   scripts/kill-workers.sh all             # EVERY ollama-*-mig worker tier
#
# Re-enable later with:  npm run deploy:workers   (recreates the autoscalers)

PROJECT="${GCP_PROJECT_ID:-yeschef-c572a}"
REGIONS=(us-central1 us-west1 us-west4 us-east1 us-east4)
ARG="${1:-llama3-1-8b-v1}"

if [ "$ARG" = "all" ]; then
  MIGS=$(gcloud compute instance-groups managed list --project="$PROJECT" \
    --format="value(name)" --filter="name~^ollama-.*-mig$" 2>/dev/null | sort -u)
else
  MIGS="ollama-${ARG}-mig"
fi

[ -z "$MIGS" ] && { echo "No matching MIGs for '$ARG'."; exit 1; }
echo "KILL: $(echo "$MIGS" | paste -sd, -)  across ${REGIONS[*]}"

for MIG in $MIGS; do
  for R in "${REGIONS[@]}"; do
    (
      # stop-autoscaling removes the autoscaler (no respawn); resize 0 drops running/staging boxes.
      # Order matters: kill the autoscaler FIRST, else resize is immediately overridden.
      gcloud compute instance-groups managed stop-autoscaling "$MIG" --project="$PROJECT" --region="$R" >/dev/null 2>&1
      gcloud compute instance-groups managed resize "$MIG" --project="$PROJECT" --region="$R" --size=0 >/dev/null 2>&1 \
        && echo "  x $MIG @ $R -> autoscaler off, size 0"
    ) &
  done
done
wait

echo "--- remaining worker instances ---"
gcloud compute instances list --project="$PROJECT" \
  --format="value(name, zone.basename(), status)" --filter="name~^ollama-" 2>/dev/null \
  | grep -vi baker || echo "  none"
echo "Done. Re-enable: npm run deploy:workers"
