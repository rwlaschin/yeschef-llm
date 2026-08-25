<!-- Compose and launch a task list: POST /ai/tquery. The tasks here are the MIDDLE of the list —
     the server wraps them (pre-sanitize … post-sanitize), which is why neither sanitizer is
     offerable below and why the submitted list can come back with two more steps than rows. -->
<template>
  <form class="max-w-3xl" @submit.prevent="submit">
    <div class="space-y-3">
      <div v-for="(t, i) in tasks" :key="i" class="surface-2 p-3 rounded-lg">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-[11px] text-muted font-mono w-5 shrink-0">{{ i + 1 }}.</span>
          <select v-model="t.subtype" class="form-input text-xs py-1 flex-1 min-w-0">
            <option v-for="s in CHOICES" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
          <button
            v-if="tasks.length > 1"
            type="button"
            title="Remove task"
            class="shrink-0 w-6 h-6 rounded flex items-center justify-center text-muted hover:bg-error/20 hover:text-error active:scale-90 transition"
            @click="tasks.splice(i, 1)"
          >×</button>
        </div>
        <!-- The chosen subtype's own description, so the picker explains itself instead of needing
             the SUBTYPES table open in another window. -->
        <p class="text-[11px] text-muted mb-2 pl-7">{{ describe(t.subtype) }}</p>
        <textarea
          v-model="t.query"
          rows="3"
          class="form-input text-sm w-full"
          placeholder="What should this step do?"
        ></textarea>
      </div>
    </div>

    <div class="flex items-center gap-3 mt-4">
      <button type="button" class="btn-muted px-3 py-1.5 rounded text-xs" @click="tasks.push({ subtype: 'task', query: '' })">
        + Add task
      </button>
      <div class="flex-1"></div>
      <button
        type="submit"
        :disabled="busy || !ready"
        class="px-5 py-2 rounded bg-amber-500 text-gray-900 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-600 transition"
      >
        {{ busy ? 'Starting…' : 'Run task list' }}
      </button>
    </div>
  </form>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { SUBTYPES } from '#models'

const emit = defineEmits(['created'])
// Same contract as MenuForm's `preset`: the selected job's saved input, or null for a fresh form.
const props = defineProps({ preset: { type: Object, default: null } })

// Everything the server will accept from a caller. The two sanitizers are inserted by /ai/tquery
// and a body that supplies one is a 400 — so they are not offered, rather than offered and rejected.
const CHOICES = SUBTYPES.filter((s) => s.name !== 'pre-sanitize' && s.name !== 'post-sanitize')
const describe = (name) => CHOICES.find((s) => s.name === name)?.description || ''

const blank = () => [{ subtype: 'task', query: '' }]
const tasks = ref(blank())
// Selecting a list in history prefills the form with what it asked for, so a variant is an edit
// rather than a retype. Submitting always starts a NEW job — /ai/tquery has no rerun.
watch(() => props.preset, (p) => {
  tasks.value = p?.tasks?.length ? p.tasks.map((t) => ({ subtype: t.subtype, query: t.query })) : blank()
}, { immediate: true })
const busy = ref(false)
const ready = computed(() => tasks.value.every((t) => t.query.trim()))

const { success, error: showError } = useToast()
const { env } = useEnvironment()
const cfg = useRuntimeConfig().public
const { getToken } = useAuth()
const aiBase = computed(() => String(env.value === 'production' ? cfg.aiBaseUrl : cfg.aiBaseUrlLocal).replace(/\/$/, ''))

const submit = async () => {
  busy.value = true
  try {
    // Identity is NOT sent: /ai/tquery reads uid/companyId off the verified token and its schema
    // rejects a body carrying them outright.
    const { jobId } = await $fetch(`${aiBase.value}/tquery`, {
      method: 'POST',
      timeout: 15000,
      headers: { Authorization: `Bearer ${await getToken()}` },
      body: { tasks: tasks.value.map((t) => ({ subtype: t.subtype, query: t.query.trim() })) },
    })
    success('Task list started', jobId.slice(0, 8))
    emit('created', jobId)
  } catch (err) {
    showError('Could not start task list', err.data?.error || err.message)
  } finally {
    busy.value = false
  }
}
</script>
