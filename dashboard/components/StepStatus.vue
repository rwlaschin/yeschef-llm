<template>
  <span class="text-xs capitalize" :class="tone">{{ status }}</span>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ status: { type: String, default: 'pending' } })

// Four states only (see config/the orchestrator): pending → running → success | fail.
// The muted "not in results" variant comes for free from the parent block's opacity, so one
// color per state is enough. Unknown → muted grey.
const tone = computed(() => ({
  pending: 'text-muted',     // grey  — message sent, not started
  running: 'text-primary',   // amber — LLM handling
  success: 'text-success',   // green — done, passed
  fail:    'text-error',     // red   — error / abort / FAIL outcome (reason in `outcome`)
}[props.status] || 'text-muted'))
</script>
