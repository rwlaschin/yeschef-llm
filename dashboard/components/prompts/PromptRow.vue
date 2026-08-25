<template>
  <article
    :draggable="!flat && type !== 'unassigned'"
    @dragstart="$emit('dragstart', type, p._id, section)"
    @dragend="$emit('dragend')"
    @dragover.prevent
    @drop.stop="$emit('drop', type, items, p._id, section)"
    @dragenter="$emit('over', p._id)"
    :class="[
      'group relative pl-6 pr-28 py-6 transition',
      dragId === p._id ? 'opacity-40' : '',
      dragType === type && overId === p._id && dragId !== p._id ? 'ring-2 ring-amber-500 rounded-lg' : '',
      !p.active ? 'opacity-50' : ''
    ]"
  >
    <!-- drag affordance (whole row is draggable) — hidden where reorder is off (flat/unassigned) -->
    <span
      v-if="!flat && type !== 'unassigned'"
      class="absolute left-0 top-6 text-muted opacity-30 group-hover:opacity-100 cursor-move select-none"
      title="Drag to reorder, or onto another section to move it there"
    >⠿</span>

    <!-- actions: active toggle, edit, delete -->
    <div class="absolute right-0 top-6 flex items-center gap-3">
      <Toggle :modelValue="p.active" @update:modelValue="$emit('toggleActive', p)" />
      <button @click="$emit('edit', p)" title="Edit" class="text-secondary hover:text-primary transition">
        <PencilSquareIcon class="w-5 h-5" />
      </button>
      <button @click="$emit('delete', p._id)" title="Delete" class="text-secondary hover:text-error transition">
        <TrashIcon class="w-5 h-5" />
      </button>
    </div>

    <!-- name (optional) + which types this prompt maps to — always visible so multi-type pinning is
         never hidden. A fragment with no name shows its id, because it still has to be identifiable. -->
    <div class="text-xs font-mono text-primary mb-2">
      <span v-if="p.name" class="text-secondary">{{ p.name }}</span>
      <span v-else class="text-muted italic">unnamed · {{ String(p._id).slice(-6) }}</span>
      <span class="text-muted"> — </span>{{ Object.keys(p.mapping || {}).sort().join(' · ') || 'unassigned' }}
      <!-- Meal-plans-only is the default and the overwhelming majority, so it gets no chip. -->
      <span v-if="scopeLabel" class="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">{{ scopeLabel }}</span>
    </div>

    <!-- full prompt, shown verbatim (whitespace + indentation preserved) -->
    <pre class="prompt-doc text-sm text-secondary whitespace-pre-wrap break-words">{{ p.content && p.content.length ? p.content : '(empty)' }}</pre>
  </article>
</template>

<script setup>
import { PencilSquareIcon, TrashIcon } from '@heroicons/vue/24/outline'
import Toggle from '~/components/Toggle.vue'
import { PROMPT_SCOPES, inScope } from '~/utils/assemblePrompt'

const props = defineProps({
  p: { type: Object, required: true },
  type: { type: String, required: true },
  section: { type: String, default: null },   // null in flat/unassigned views
  items: { type: Array, default: () => [] },  // the list this row is ordered within
  flat: { type: Boolean, default: false },
  dragId: { type: String, default: null },
  dragType: { type: String, default: null },
  overId: { type: String, default: null },
})
defineEmits(['dragstart', 'dragend', 'over', 'drop', 'edit', 'delete', 'toggleActive'])

// Asked through the WORKER's `inScope`, never by reading `scopes` directly — an absent field is
// meal-plans-only, so a chip derived from the raw array would call those prompts unrestricted.
// Serving BOTH is the interesting case here: everything unscoped is meal-plan, so labelling that
// on ~36 rows is noise, while a task-list prompt has to be visible without opening the editor.
const scopeLabel = computed(() => {
  const scopes = PROMPT_SCOPES.filter((s) => inScope(props.p, s))
  return scopes.length === PROMPT_SCOPES.length ? 'both pipelines' : scopes[0] === 'task_list' ? 'task lists only' : ''
})
</script>

<style scoped>
.prompt-doc {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.5;
  margin: 0;
}
</style>
