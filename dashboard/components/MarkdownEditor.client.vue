<template>
  <div class="cm-wrap border border-gray-700/40 rounded-lg overflow-hidden">
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

// Plain-text editor: dark theme + line wrapping only. No language/syntax pass
// that could reinterpret YAML-ish structure or `#`.
const extensions = [oneDark, EditorView.lineWrapping]
</script>

<style scoped>
.cm-wrap :deep(.cm-editor) { min-height: 22rem; font-size: 13px; }
.cm-wrap :deep(.cm-editor.cm-focused) { outline: none; }
.cm-wrap :deep(.cm-scroller) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
