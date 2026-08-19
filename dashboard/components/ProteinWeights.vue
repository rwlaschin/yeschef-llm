<!-- Protein rotation list — mirrors the app's setup-page control
     (yeschef/src/components/plans/ProteinWeights.tsx). The rows are NOT typed by hand: the
     `protein_dietary_categorization` step produces them from the plan's own diets, so name, cut and
     diets are read-only here and the chef only sets ORDER (priority) and WEIGHT (share of the cycle).
     A weight of 0 means "not in this rotation". Adding a protein re-runs the step so the model works
     out its diets; removing one is local and never re-runs it. -->
<template>
  <div class="space-y-2">
    <!-- The busy line shows whether the list is empty or already populated: a refetch over existing
         rows is the case where nothing on screen would otherwise say a job is running. -->
    <p v-if="loading || refreshing" class="text-[11px] text-amber-400">
      Asking Remy which proteins suit these diets…
    </p>

    <div v-else-if="!rows.length" class="text-[11px] text-muted">
      Pick diets above and the protein list arrives here, ready to prioritise.
    </div>

    <div v-for="(p, i) in rows" :key="`${p.protein}|${p.cut}`" class="rounded-lg border border-divider surface-2-soft p-2">
      <div class="flex items-center gap-2">
        <!-- Up/down instead of drag: order is the only thing being expressed, and arrows say it
             without a pointer-capture dance. -->
        <div class="flex flex-col shrink-0 leading-none">
          <button type="button" :disabled="i === 0" title="Move up" class="text-[10px] text-muted hover:text-amber-400 disabled:opacity-30 transition" @click="move(i, -1)">▲</button>
          <button type="button" :disabled="i === rows.length - 1" title="Move down" class="text-[10px] text-muted hover:text-amber-400 disabled:opacity-30 transition" @click="move(i, 1)">▼</button>
        </div>
        <!-- Name over diets: side by side, a long name and a long diet list truncate each other. -->
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-primary" :title="p.protein">
            {{ p.protein }}<span v-if="p.cut" class="text-secondary"> · {{ p.cut }}</span>
          </span>
          <span class="block truncate text-[11px] text-muted" :title="(p.diets || []).join(', ')">{{ (p.diets || []).join(', ') }}</span>
        </span>
        <input :value="p.weight" type="number" min="0" max="100" step="1" class="form-input w-16 text-xs py-1 text-right" @input="setWeight(i, $event.target.value)" />
        <span class="text-[11px] text-muted w-10 text-right tabular-nums">{{ pct(p) }}%</span>
        <button type="button" title="Remove" class="shrink-0 text-muted hover:text-red-400 transition" @click="emit('remove', p.protein)">
          <XMarkIcon class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- A new protein is TYPED, not chosen from a catalog — the model then works out its diets, so
         there is no diet picker here. -->
    <div class="flex items-center gap-2">
      <input
        v-model="draft"
        type="text"
        maxlength="120"
        :disabled="adding"
        class="form-input flex-1 text-sm"
        placeholder="Add a protein — Enter to add"
        @keydown.enter.prevent="add"
      />
      <button
        type="button"
        :disabled="adding || !draft.trim()"
        class="px-3 py-2 rounded text-xs text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 disabled:hover:bg-transparent transition whitespace-nowrap"
        @click="add"
      >{{ adding ? 'Checking diets…' : 'Add Protein' }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { XMarkIcon } from '@heroicons/vue/24/solid'

const props = defineProps({
  modelValue: { type: Array, default: () => [] }, // [{ protein, cut, diets[], weight }]
  loading: { type: Boolean, default: false },     // categorization step is out and the list is empty
  refreshing: { type: Boolean, default: false },  // a step is out over an already-populated list
  adding: { type: Boolean, default: false },      // a typed protein is being classified
})
// Removal is reported separately from update:modelValue so the form can REMEMBER it — filtering the
// array alone would let the next re-fetch resurrect the protein.
const emit = defineEmits(['update:modelValue', 'add', 'remove'])

const rows = computed(() => props.modelValue)
const draft = ref('')

const total = computed(() => rows.value.reduce((s, p) => s + (Number(p.weight) || 0), 0))
const pct = (p) => (total.value ? Math.round((Number(p.weight) || 0) / total.value * 100) : 0)

const commit = (next) => emit('update:modelValue', next)
const setWeight = (i, raw) => {
  const w = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)))
  commit(rows.value.map((p, j) => (j === i ? { ...p, weight: w } : p)))
}
const move = (i, delta) => {
  const next = [...rows.value]
  next.splice(i + delta, 0, next.splice(i, 1)[0])
  commit(next)
}
const add = () => {
  const name = draft.value.trim()
  if (!name || props.adding) return
  draft.value = ''
  emit('add', name)
}
</script>
