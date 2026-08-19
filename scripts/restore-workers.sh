#!/usr/bin/env bash
# Return worker MIG(s) to their steady state after scripts/kill-workers.sh: size 0 with NO
# autoscaler in any region, which is all the capacity control loop needs to steer them
# (functions/entry/ai/capacity/actuate.js sets the MIG target size itself). No rebuild/rebake —
# the instance template is untouched.
#
# There is deliberately no autoscaler to re-arm: GCE rejects resize with 412 on an autoscaled MIG,
# so an autoscaler BLOCKS the control loop's shrink/release and recreates every box the worker
# self-deletes. Mirrors scripts/deploy.js, which stop-autoscalings every region for the same reason.
#
# Usage:
#   scripts/restore-workers.sh                 # llama3-1-8b tier (default)
#   scripts/restore-workers.sh gemma4-12b-v1   # a specific tier by slug
#   scripts/restore-workers.sh all             # every ollama-*-mig tier

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
echo "RESTORE: $(echo "$MIGS" | paste -sd, -)  across ${REGIONS[*]}  (size 0, no autoscaler)"

for MIG in $MIGS; do
  for R in "${REGIONS[@]}"; do
    (
      gcloud compute instance-groups managed stop-autoscaling "$MIG" --project="$PROJECT" --region="$R" >/dev/null 2>&1
      gcloud compute instance-groups managed resize "$MIG" --project="$PROJECT" --region="$R" --size=0 >/dev/null 2>&1
      echo "  . $MIG @ $R ready (size 0, no autoscaler)"
    ) &
  done
done
wait
echo "Done. MIGs idle at 0; the capacity loop starts boxes on demand."
