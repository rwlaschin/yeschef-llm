<template>
  <div class="glass p-6">
    <!-- Target Environment -->
    <div class="mb-6">
      <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Target Environment</p>
      <div class="grid grid-cols-2 gap-6">
        <div class="flex border border-gray-600 rounded-lg overflow-hidden w-fit">
          <button
            @click="currentEnv = 'local'"
            :class="[
              'flex-1 px-3 py-1 text-xs font-medium transition',
              currentEnv === 'local'
                ? 'bg-amber-500 text-gray-900'
                : 'bg-gray-800/40 text-gray-300 hover:text-amber-400'
            ]"
          >
            Development
          </button>
          <div class="w-px bg-gray-600"></div>
          <button
            @click="currentEnv = 'production'"
            :class="[
              'flex-1 px-3 py-1 text-xs font-medium transition',
              currentEnv === 'production'
                ? 'bg-amber-500 text-gray-900'
                : 'bg-gray-800/40 text-gray-300 hover:text-amber-400'
            ]"
          >
            Production
          </button>
        </div>
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wide mb-1">GCP Project</p>
          <p class="text-sm font-mono text-amber-400">yeschef-c572a</p>
        </div>
      </div>
    </div>

    <!-- Services -->
    <div class="mb-6">
      <div class="flex items-center justify-between mb-4">
        <p class="text-xs font-medium text-gray-400 uppercase tracking-wide">Services</p>
        <button
          @click="checkHealth"
          class="px-2 py-1 text-xs bg-gray-800/40 hover:bg-gray-700/40 text-gray-300 hover:text-amber-400 rounded transition"
        >
          Refresh
        </button>
      </div>
      <div class="grid grid-cols-3 gap-3 text-sm mb-6">
        <div class="flex items-center gap-2">
          <span :class="['w-2 h-2 rounded-full', status.databases.mongodb.ok ? 'bg-green-500' : 'bg-red-500']"></span>
          <span>MongoDB</span>
          <span v-if="status.databases.mongodb.error" class="text-xs text-gray-500">{{ status.databases.mongodb.error }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span :class="['w-2 h-2 rounded-full', status.databases.firebase.ok ? 'bg-green-500' : 'bg-red-500']"></span>
          <span>Firebase</span>
          <span v-if="status.databases.firebase.error" class="text-xs text-gray-500">{{ status.databases.firebase.error }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span :class="['w-2 h-2 rounded-full', status.databases.neo4j.ok ? 'bg-green-500' : 'bg-red-500']"></span>
          <span>Neo4j</span>
          <span v-if="status.databases.neo4j.error" class="text-xs text-gray-500">{{ status.databases.neo4j.error }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span :class="['w-2 h-2 rounded-full', status.pubsub.ok ? 'bg-green-500' : 'bg-red-500']"></span>
          <span>Pub/Sub</span>
          <span v-if="status.pubsub.error" class="text-xs text-gray-500">{{ status.pubsub.error }}</span>
        </div>
      </div>

      <!-- Models -->
      <div class="mt-6">
        <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Models <span class="text-gray-600 normal-case">(./shared)</span></p>
        <div v-if="Object.keys(status.models).length > 0" class="space-y-1 text-sm">
          <div v-for="(model, name) in status.models" :key="name" class="flex items-center gap-2">
            <span :class="['w-2 h-2 rounded-full', model.ok ? 'bg-green-500' : 'bg-red-500']"></span>
            <span>{{ name }}</span>
            <span :class="['text-xs', model.ok ? 'text-green-400' : 'text-gray-500']">{{ model.ok ? 'Ready' : `Not available${model.error ? ` - ${model.error}` : ''}` }}</span>
          </div>
        </div>
        <p v-else class="text-xs text-gray-500">No models found</p>
      </div>
    </div>

    <!-- Quick Links -->
    <div>
      <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Quick Links</p>
      <div class="flex flex-wrap gap-2">
        <a href="mongodb://localhost:27017" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">MongoDB</a>
        <a href="https://browser.neo4j.io" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Neo4j</a>
        <a href="https://console.firebase.google.com/project/yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Firebase</a>
        <a v-if="currentEnv === 'local'" href="http://localhost:4000" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Emulator</a>
        <a v-if="currentEnv === 'local'" href="http://localhost:11434" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Ollama</a>
        <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/compute/instances?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Compute Engine</a>
        <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/run?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Cloud Run</a>
        <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/logs/query?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Cloud Logging</a>
        <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/artifacts?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs bg-gray-800/40 hover:text-amber-400 transition">Artifacts</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const currentEnv = ref('local')
const status = ref({
  databases: {
    mongodb: { ok: false, error: '' },
    firebase: { ok: false, error: '' },
    neo4j: { ok: false, error: '' },
  },
  pubsub: { ok: false, error: '' },
  models: {},
})

const statusColor = computed(() => {
  let healthy = 0
  let total = 4
  if (status.value.databases.mongodb.ok) healthy++
  if (status.value.databases.firebase.ok) healthy++
  if (status.value.databases.neo4j.ok) healthy++
  if (status.value.pubsub.ok) healthy++
  if (healthy === total) return 'bg-green-500'
  if (healthy === 0) return 'bg-red-500'
  return 'bg-yellow-500'
})

const checkHealth = async () => {
  try {
    const response = await $fetch(`/api/health?env=${currentEnv.value}`)
    status.value = response
  } catch (error) {
    const errorMsg = error?.status === 404 || error?.message?.includes('fetch') ? 'Backend offline' : 'Check failed'
    status.value = {
      databases: {
        mongodb: { ok: false, error: errorMsg },
        firebase: { ok: false, error: errorMsg },
        neo4j: { ok: false, error: errorMsg }
      },
      pubsub: { ok: false, error: errorMsg },
      models: {}
    }
  }
}

// Self-cancelling, non-overlapping poll — was leaking a 5s interval on every
// visit to this page; that congestion is what made fast nav land on a stale route.
usePoll(checkHealth, 5000)

watch(currentEnv, () => {
  checkHealth()
})
</script>
