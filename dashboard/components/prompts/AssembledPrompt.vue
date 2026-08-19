<!-- The exact system-prompt string the worker assembles for one type, from what's in the library
     right now. NOT a run's prompt — the Request page's Prompt tab shows that (system + tools +
     subtypes + request, from a job that actually ran). This is the library half, before any run. -->
<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-start justify-between gap-4 mb-1">
      <!-- Called from a list (the Plan Library), the type alone doesn't say WHICH row you opened,
           so the caller can name the subject and the type drops to a subtitle. -->
      <div class="min-w-0">
        <h1 v-if="subject" class="text-2xl font-serif text-primary truncate" :title="subject">
          What the model reads for {{ subject }}
        </h1>
        <h1 v-else class="text-2xl font-serif text-primary truncate" :title="type">
          What the model reads for <span class="font-mono text-xl">{{ type }}</span>
        </h1>
        <div v-if="subject" class="text-xs font-mono text-muted truncate" :title="type">{{ type }}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          @click="copy(text, 'Prompt copied')"
          :disabled="!text"
          class="flex items-center gap-2 px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ClipboardDocumentIcon class="w-4 h-4" />
          Copy
        </button>
        <button
          @click="$emit('close')"
          class="px-4 py-2 rounded-lg font-medium text-secondary hover:text-primary transition"
        >
          Close
        </button>
      </div>
    </div>

    <!-- What the worker would actually load: prod filters to active, dev includes inactive. -->
    <div class="flex items-center gap-2 text-xs text-muted mb-1">
      <span>{{ systemParts.length }} in the system message</span>
      <span>·</span>
      <span class="tabular-nums">{{ text.length.toLocaleString() }} characters</span>
      <span>·</span>
      <span>{{ includeInactive ? 'inactive prompts included (dev)' : 'switched-on prompts only (production)' }}</span>
    </div>

    <!-- Placed fragments are NOT part of the system message — they are substituted into the step's
         own prompt at send time, so their position only exists relative to a step. Saying "N joined
         in order" while a pass-anchored fragment sits elsewhere would make this screen lie. -->
    <div v-if="placedParts.length" class="text-xs text-muted mb-4">
      {{ placedParts.length }} more {{ placedParts.length === 1 ? 'prompt is' : 'prompts are' }} placed inside the step's own prompt rather than here —
      <span class="font-mono">{{ placedSummary }}</span>. The model reads {{ placedParts.length === 1 ? 'it' : 'them' }} too.
    </div>
    <div v-else class="mb-4"></div>

    <div v-if="!parts.length" class="text-muted text-sm py-10 text-center">
      No prompts are assigned to “{{ type }}” — the model gets no instructions for this request type.
    </div>

    <div v-else class="flex-1 overflow-auto min-h-0 pr-1">
      <div v-for="(s, i) in systemParts" :key="s.prompt._id">
        <!-- Provenance ruler: which library entry this run of text came from, and its order key. -->
        <div class="flex items-center gap-2 text-[11px] font-mono text-muted my-2">
          <span class="shrink-0">prompt {{ i + 1 }} of {{ systemParts.length }}</span>
          <span v-if="tied.has(String(s.prompt.mapping[type]))" class="shrink-0 text-amber-500" title="Another prompt has the same position, so which one comes first can change between runs">⚠ same position as another prompt</span>
          <span v-if="!s.prompt.active" class="shrink-0 text-amber-500">switched off</span>
          <span class="h-px flex-1 bg-gray-400/30 dark:bg-white/10"></span>
        </div>
        <CollapsibleSections :text="s.content" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ClipboardDocumentIcon } from '@heroicons/vue/24/outline'
import CollapsibleSections from '~/components/CollapsibleSections.vue'
import { assemblePrompt, tiedOrderKeys, SYSTEM } from '~/utils/assemblePrompt'

const props = defineProps({
  type: { type: String, required: true },
  prompts: { type: Array, default: () => [] },
  includeInactive: { type: Boolean, default: false },
  subject: { type: String, default: '' },
})
defineEmits(['close'])

const { copy } = useClipboard()
const assembled = computed(() => assemblePrompt(props.prompts, props.type, { includeInactive: props.includeInactive }))
const parts = computed(() => assembled.value.parts)
// Only the system-message fragments are shown as the joined text — that IS the system message.
// Placed fragments go into the step's own prompt and are summarised instead, because their position
// exists only relative to a step and this screen has no step.
const systemParts = computed(() => parts.value.filter((p) => p.section === SYSTEM))
const placedParts = computed(() => parts.value.filter((p) => p.section !== SYSTEM))
const placedSummary = computed(() =>
  [...new Set(placedParts.value.map((p) => p.section))].join(', '))
const text = computed(() => systemParts.value.map((p) => p.content).join('\n\n'))
const tied = computed(() => tiedOrderKeys(systemParts.value, props.type))
</script>
