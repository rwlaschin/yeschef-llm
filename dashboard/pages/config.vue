<template>
  <div class="glass p-6">
    <!-- Target Environment -->
    <div class="mb-6">
      <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Target Environment</p>
      <div class="grid grid-cols-2 gap-6">
        <ClientOnly>
          <div class="flex border border-gray-600 rounded-lg overflow-hidden w-fit">
            <button
              @click="switchEnv('local')"
              :class="[
                'flex-1 px-3 py-1 text-xs font-medium transition',
                currentEnv === 'local'
                  ? 'bg-amber-500 text-gray-900'
                  : 'surface-2 text-secondary hover:text-amber-400'
              ]"
            >
              Development
            </button>
            <div class="w-px bg-gray-600"></div>
            <button
              @click="switchEnv('production')"
              :class="[
                'flex-1 px-3 py-1 text-xs font-medium transition',
                currentEnv === 'production'
                  ? 'bg-amber-500 text-gray-900'
                  : 'surface-2 text-secondary hover:text-amber-400'
              ]"
            >
              Production
            </button>
          </div>
        </ClientOnly>
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wide mb-1">GCP Project</p>
          <p class="text-sm font-mono text-amber-400">yeschef-c572a</p>
        </div>
      </div>
    </div>

    <!-- Services — all health.* state is client-only (seeded from localStorage on init);
         wrapping in ClientOnly prevents SSR rendering offline() state that mismatches the
         localStorage-seeded client state and causes hydration errors. -->
    <ClientOnly>
      <template #fallback>
        <div class="mb-6">
          <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-4">Services</p>
          <div class="grid grid-cols-3 gap-3 text-sm mb-6">
            <div v-for="label in ['MongoDB','Firebase','Neo4j','Pub/Sub','Orchestrator']" :key="label" class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full shrink-0 bg-gray-600"></span>
              <span class="shrink-0">{{ label }}</span>
            </div>
          </div>
        </div>
      </template>
      <div class="mb-6">
        <div class="flex items-center justify-between mb-4">
          <!-- NO HealthRing here. The per-service rows below already show each status; the
               ring is redundant on this page. It belongs ONLY in the header (layouts/default.vue).
               DO NOT add <HealthRing> back to this page. -->
          <div class="flex items-center gap-2">
            <p class="text-xs font-medium text-gray-400 uppercase tracking-wide">Services</p>
            <span v-if="switching" class="text-xs text-amber-400 animate-pulse">Checking…</span>

          </div>
          <button
            @click="refresh"
            class="px-2 py-1 text-xs surface-2 hover:bg-gray-200 dark:hover:bg-gray-700/40 text-secondary hover:text-amber-400 rounded transition"
          >
            Refresh
          </button>
        </div>
        <div class="grid grid-cols-3 gap-3 text-sm mb-6">
          <div class="flex items-center gap-2 min-w-0">
            <span :class="['w-2 h-2 rounded-full shrink-0', switching ? 'bg-gray-600' : health.databases.mongodb.ok ? 'bg-green-500' : 'bg-red-500']"></span>
            <span class="shrink-0">MongoDB</span>
            <span v-if="health.databases.mongodb.error" class="text-xs text-gray-500 truncate min-w-0" :title="health.databases.mongodb.error">{{ health.databases.mongodb.error }}</span>
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <span :class="['w-2 h-2 rounded-full shrink-0', switching ? 'bg-gray-600' : health.databases.firebase.ok ? 'bg-green-500' : 'bg-red-500']"></span>
            <span class="shrink-0">Firebase</span>
            <span v-if="health.databases.firebase.error" class="text-xs text-gray-500 truncate min-w-0" :title="health.databases.firebase.error">{{ health.databases.firebase.error }}</span>
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <span :class="['w-2 h-2 rounded-full shrink-0', switching ? 'bg-gray-600' : health.databases.neo4j.ok ? 'bg-green-500' : 'bg-red-500']"></span>
            <span class="shrink-0">Neo4j</span>
            <span v-if="health.databases.neo4j.error" class="text-xs text-gray-500 truncate min-w-0" :title="health.databases.neo4j.error">{{ health.databases.neo4j.error }}</span>
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <span :class="['w-2 h-2 rounded-full shrink-0', switching ? 'bg-gray-600' : health.pubsub.ok ? 'bg-green-500' : 'bg-red-500']"></span>
            <span class="shrink-0">Pub/Sub</span>
            <span v-if="health.pubsub.error" class="text-xs text-gray-500 truncate min-w-0" :title="health.pubsub.error">{{ health.pubsub.error }}</span>
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <span :class="['w-2 h-2 rounded-full shrink-0', switching ? 'bg-gray-600' : health.orchestrator.ok ? 'bg-green-500' : 'bg-red-500']"></span>
            <span class="shrink-0">Orchestrator</span>
            <span v-if="health.orchestrator.error" class="text-xs text-gray-500 truncate min-w-0" :title="health.orchestrator.error">{{ health.orchestrator.error }}</span>
          </div>
        </div>

        <!-- Models -->
        <div class="mt-6">
          <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Models</p>
          <div v-if="Object.keys(health.models).length > 0" class="grid grid-cols-3 gap-4 text-sm">
            <div v-for="(model, name) in health.models" :key="name" class="flex items-center gap-2 min-w-0">
              <!-- 3-segment bar: dev = binary (ok → 3 lit), prod = MIG instance count -->
              <div class="flex items-end gap-px shrink-0">
                <span :class="['w-1.5 h-2 rounded-sm transition-colors', switching || !model.ok ? 'bg-gray-600' : model.instances === undefined ? 'bg-green-300' : (model.instances ?? 0) >= 1 ? 'bg-green-300' : 'bg-gray-600']"></span>
                <span :class="['w-1.5 h-3 rounded-sm transition-colors', switching || !model.ok ? 'bg-gray-600' : model.instances === undefined ? 'bg-green-500' : (model.instances ?? 0) >= 4 ? 'bg-green-500' : 'bg-gray-600']"></span>
                <span :class="['w-1.5 h-4 rounded-sm transition-colors', switching || !model.ok ? 'bg-gray-600' : model.instances === undefined ? 'bg-green-700' : (model.instances ?? 0) >= 7 ? 'bg-green-700' : 'bg-gray-600']"></span>
              </div>
              <span class="shrink-0 truncate">{{ name }}</span>
            </div>
          </div>
          <p v-else class="text-xs text-gray-500">No models found</p>
        </div>
      </div>
    </ClientOnly>

    <!-- Quick Links -->
    <div>
      <p class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Quick Links</p>
      <ClientOnly>
        <div class="flex flex-wrap gap-2">
          <a href="mongodb://localhost:27017" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">MongoDB</a>
          <a href="https://browser.neo4j.io" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Neo4j</a>
          <a href="https://console.firebase.google.com/project/yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Firebase</a>
          <a v-if="currentEnv === 'local'" href="http://localhost:4000" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Emulator</a>
          <a v-if="currentEnv === 'local'" href="http://localhost:11434" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Ollama</a>
          <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/compute/instances?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Compute Engine</a>
          <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/run?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Cloud Run</a>
          <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/logs/query?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Cloud Logging</a>
          <a v-if="currentEnv === 'production'" href="https://console.cloud.google.com/artifacts?project=yeschef-c572a" target="_blank" class="px-3 py-1 rounded text-xs surface-2 hover:text-amber-400 transition">Artifacts</a>
        </div>
      </ClientOnly>
    </div>
  </div>
</template>

<script setup>
const { env: currentEnv, setEnv } = useEnvironment()
const { health, refresh } = useHealth()

// Local switching state — works in both leader and follower tabs.
// checking only fires in the leader; switching fires on this tab's click and clears on next health update.
const switching = ref(false)
const switchEnv = (v) => { switching.value = true; setEnv(v) }
watch(health, () => { switching.value = false }, { deep: true })
</script>
