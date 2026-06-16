<template>
  <div class="cm-wrap border-divider rounded-lg overflow-hidden">
    <Codemirror
      v-model="model"
      :extensions="extensions"
      :indent-with-tab="true"
      :tab-size="2"
      :style="{ minHeight: '22rem' }"
      placeholder="Write the prompt exactly as it should reach the model — whitespace, indentation and # are kept verbatim."
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Codemirror } from 'vue-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'

const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue'])

// Pure pass-through: what you type is byte-for-byte what's stored. No markdown
// engine, no parse/serialize, no "fix-ups" — so nothing comes back different.
const model = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const { isDark } = useTheme()

// Light editor theme — readable dark text on white (oneDark is unreadable on a
// light page). High-contrast body text, amber caret/selection to match the app.
const lightTheme = EditorView.theme(
  {
    '&': { color: '#111827', backgroundColor: '#ffffff' },
    '.cm-content': { caretColor: '#d97706' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#d97706' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: '#fde68a' },
    '.cm-gutters': { backgroundColor: '#f9fafb', color: '#9ca3af', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: '#f3f4f6' },
    '.cm-placeholder': { color: '#9ca3af' },
  },
  { dark: false }
)

// Theme follows the app toggle; line wrapping only — no language/syntax pass that
// could reinterpret YAML-ish structure or `#`. Reactive so toggling re-themes live.
const extensions = computed(() => [isDark.value ? oneDark : lightTheme, EditorView.lineWrapping])
</script>

<style scoped>
.cm-wrap :deep(.cm-editor) { min-height: 22rem; font-size: 13px; }
.cm-wrap :deep(.cm-editor.cm-focused) { outline: none; }
.cm-wrap :deep(.cm-scroller) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
