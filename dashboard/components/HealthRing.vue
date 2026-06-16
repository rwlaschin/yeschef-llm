<template>
  <!-- A donut: each service is an equal wedge of the ring — green = passing, red = failing.
       conic-gradient for the wedges + a radial mask to punch the hollow center. No grid, no
       SVG, no dividers. Fixed px size so it can't grow and break the header. -->
  <span class="rounded-full shrink-0 block" :style="ringStyle" />
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Segment { key?: string; label: string; ok: boolean; error?: string }

const props = withDefaults(defineProps<{
  segments: Segment[]
  size?: number // rendered px. Keep small — must not exceed other header elements.
}>(), {
  size: 22,
})

// Glassy jewel tones (translucent so the dark header shows through a touch) rather than the
// flat green-500/red-500.
const GREEN = 'rgba(52, 211, 153, 0.9)'  // emerald-400, glassy
const RED = 'rgba(251, 113, 133, 0.9)'   // rose-400, glassy

// N equal wedges, each 360/N°, colored by status. Hard stops = crisp slices, no dividers.
const pie = computed(() => {
  const segs = props.segments.length ? props.segments : [{ label: 'No checks', ok: false }]
  const step = 360 / segs.length
  const stops = segs
    .map((s, i) => `${s.ok ? GREEN : RED} ${(i * step).toFixed(3)}deg ${((i + 1) * step).toFixed(3)}deg`)
    .join(', ')
  return `conic-gradient(${stops})`
})

// rounded-full clips the outer edge to a circle; the radial mask cuts the inner hole → donut.
const HOLE = 'radial-gradient(circle, transparent 38%, #000 39%)'
const ringStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  background: pie.value,
  WebkitMask: HOLE,
  mask: HOLE,
}))
</script>
