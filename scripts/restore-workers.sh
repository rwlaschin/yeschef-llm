#!/usr/bin/env bash
# Restore worker autoscaling after scripts/kill-workers.sh. Re-attaches the Pub/Sub-backlog
# autoscaler to the existing MIG(s) across all regions — no rebuild/rebake, because kill only
# removed the autoscaler and resized to 0; the instance template is untouched.
#
# The autoscaling config MIRRORS scripts/deploy.js setMigAutoscaling (num_undelivered_messages,
# single-instance-assignment=1, min 0 / max 7, 60s scale-in) so restore == what a deploy would set.
#
# Usage:
#   scripts/restore-workers.sh                 # llama3-1-8b tier (default)
#   scripts/restore-workers.sh gemma4-12b-v1   # a specific tier by slug
#   scripts/restore-workers.sh all             # every ollama-*-mig tier
#
# NOTE: this re-arms the SAME per-message × multi-region scaling that caused the stockout loop.
# It can recur under a regional stockout until the autoscaler/manager fix lands.

PROJECT="${GCP_PROJECT_ID:-yeschef-c572a}"
REGIONS=(us-central1 us-west1 us-west4 us-east1 us-east4)
MAX_REPLICAS="${MAX_REPLICAS:-7}"
PRIMARY="${PRIMARY_REGION:-us-west1}"   # ONLY this region autoscales; the rest stay standby
ASSIGN="${PARALLEL:-2}"                 # messages per box (worker OLLAMA_NUM_PARALLEL) — not 1
ARG="${1:-llama3-1-8b-v1}"

if [ "$ARG" = "all" ]; then
  MIGS=$(gcloud compute instance-groups managed list --project="$PROJECT" \
    --format="value(name)" --filter="name~^ollama-.*-mig$" 2>/dev/null | sort -u)
else
  MIGS="ollama-${ARG}-mig"
fi

[ -z "$MIGS" ] && { echo "No matching MIGs for '$ARG'."; exit 1; }
echo "RESTORE: $(echo "$MIGS" | paste -sd, -)  across ${REGIONS[*]}  (max=$MAX_REPLICAS)"

for MIG in $MIGS; do
  # slug = MIG without the ollama- prefix and -mig suffix; subscription = sub_<slug with - -> _>.
  SLUG="${MIG#ollama-}"; SLUG="${SLUG%-mig}"
  SUB="sub_$(echo "$SLUG" | tr '-' '_')"
  for R in "${REGIONS[@]}"; do
    (
      if [ "$R" = "$PRIMARY" ]; then
        gcloud compute instance-groups managed set-autoscaling "$MIG" \
          --project="$PROJECT" --region="$R" \
          --min-num-replicas=0 --max-num-replicas="$MAX_REPLICAS" \
          --update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages \
          --stackdriver-metric-filter="resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"$SUB\"" \
          --stackdriver-metric-single-instance-assignment="$ASSIGN" \
          --scale-in-control=max-scaled-in-replicas-percent=100,time-window=60 >/dev/null 2>&1 \
          && echo "  + $MIG @ $R PRIMARY -> autoscaling on ($SUB, 0-$MAX_REPLICAS, $ASSIGN msg/box)"
      else
        # Standby: ensure no autoscaler so siblings don't race the shared subscription.
        gcloud compute instance-groups managed stop-autoscaling "$MIG" --project="$PROJECT" --region="$R" >/dev/null 2>&1
        echo "  . $MIG @ $R standby (no autoscaler)"
      fi
    ) &
  done
done
wait
echo "Done. Autoscalers re-armed; they scale up on backlog."
