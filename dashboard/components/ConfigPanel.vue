<template>
  <div class="glass p-6">
    <div class="space-y-4">
      <!-- Environment Toggle -->
      <div>
        <label class="block text-sm font-medium text-gray-300 mb-2">
          Target Environment
        </label>
        <div class="flex gap-4">
          <button
            @click="selectEnv('local')"
            :class="[
              'px-4 py-2 rounded-lg font-medium transition focus:outline-none focus:ring-2 focus:ring-amber-500',
              currentEnv === 'local'
                ? 'bg-amber-500 text-gray-900 shadow-lg'
                : 'glass hover:bg-opacity-50',
            ]"
            :aria-pressed="currentEnv === 'local'"
          >
            Local Dev
          </button>
          <button
            @click="selectEnv('production')"
            :class="[
              'px-4 py-2 rounded-lg font-medium transition focus:outline-none focus:ring-2 focus:ring-amber-500',
              currentEnv === 'production'
                ? 'bg-amber-500 text-gray-900 shadow-lg'
                : 'glass hover:bg-opacity-50',
            ]"
            :aria-pressed="currentEnv === 'production'"
          >
            Production
          </button>
        </div>
      </div>

      <!-- Status Info -->
      <div class="grid grid-cols-2 gap-4 pt-4">
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">GCP Project</p>
          <p class="text-sm font-mono text-amber-400">yeschef-c572a</p>
        </div>
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Environment</p>
          <p class="text-sm font-mono" :class="currentEnv === 'local' ? 'text-green-400' : 'text-red-400'">
            {{ currentEnv }}
          </p>
        </div>
      </div>

      <!-- Connection Status -->
      <div class="pt-4">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Service Status</p>
        <div class="space-y-2 text-sm">
          <div class="relative group">
            <div class="flex items-center gap-2 p-2 rounded hover:bg-gray-700/20 transition cursor-help">
              <span :class="['w-2 h-2 rounded-full', status.mongodb ? 'bg-green-500' : 'bg-red-500']"></span>
              <span>MongoDB</span>
              <span class="text-xs text-gray-500">{{ currentEnv === 'local' ? '(Atlas)' : '(Production)' }}</span>
            </div>
            <div class="absolute hidden group-hover:block bottom-full left-0 mb-2 bg-gray-950 border border-gray-700 rounded-lg p-2 text-xs whitespace-nowrap text-gray-300 z-50">
              {{ status.mongodb ? 'Connected' : 'Failed to connect' }}
            </div>
          </div>

          <div class="relative group">
            <div class="flex items-center gap-2 p-2 rounded hover:bg-gray-700/20 transition cursor-help">
              <span :class="['w-2 h-2 rounded-full', status.pubsub ? 'bg-green-500' : 'bg-red-500']"></span>
              <span>Pub/Sub</span>
              <span class="text-xs text-gray-500">{{ currentEnv === 'local' ? '(Emulator)' : '(GCP)' }}</span>
            </div>
            <div class="absolute hidden group-hover:block bottom-full left-0 mb-2 bg-gray-950 border border-gray-700 rounded-lg p-2 text-xs whitespace-nowrap text-gray-300 z-50">
              {{ status.pubsub ? 'Emulator running' : 'Emulator not running' }}
            </div>
          </div>

          <div class="relative group">
            <div class="flex items-center gap-2 p-2 rounded hover:bg-gray-700/20 transition cursor-help">
              <span :class="['w-2 h-2 rounded-full', status.ollama ? 'bg-green-500' : 'bg-red-500']"></span>
              <span>Ollama</span>
              <span class="text-xs text-gray-500">{{ currentEnv === 'local' ? '(localhost:11434)' : '(Cloud Run)' }}</span>
            </div>
            <div class="absolute hidden group-hover:block bottom-full left-0 mb-2 bg-gray-950 border border-gray-700 rounded-lg p-2 text-xs whitespace-nowrap text-gray-300 z-50">
              {{ status.ollama ? 'Running' : 'Not accessible' }}
            </div>
          </div>

          <div class="relative group">
            <div class="flex items-center gap-2 p-2 rounded hover:bg-gray-700/20 transition cursor-help">
              <span :class="['w-2 h-2 rounded-full', status.neo4j ? 'bg-green-500' : 'bg-red-500']"></span>
              <span>Neo4j</span>
              <span class="text-xs text-gray-500">{{ currentEnv === 'local' ? '(Aura)' : '(Production)' }}</span>
            </div>
            <div class="absolute hidden group-hover:block bottom-full left-0 mb-2 bg-gray-950 border border-gray-700 rounded-lg p-2 text-xs whitespace-nowrap text-gray-300 z-50">
              {{ status.neo4j ? 'Connected' : 'Failed to connect' }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const emit = defineEmits(["environment-changed"]);

// Shared toggle state — read by the Request page and sent to the server.
const { env: currentEnv, setEnv } = useEnvironment();
const status = ref({
  mongodb: false,
  pubsub: false,
  ollama: false,
  neo4j: false,
});

const selectEnv = (env) => {
  setEnv(env);
  emit("environment-changed", env);
};

const checkHealth = async () => {
  try {
    const response = await $fetch("/api/health");
    status.value = response;
  } catch (error) {
    console.error("Health check failed:", error);
    status.value = {
      mongodb: false,
      pubsub: false,
      ollama: false,
      neo4j: false,
    };
  }
};

onMounted(() => {
  checkHealth();
  // Re-check every 5 seconds
  setInterval(checkHealth, 5000);
});
</script>
