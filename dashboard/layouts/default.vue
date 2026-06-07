<template>
  <div class="h-screen flex flex-col transition-colors duration-300">
    <header class="sticky top-0 z-40 bg-gray-900/40 backdrop-blur-md">
      <div class="max-w-full px-6 py-4 flex items-center justify-between">
        <!-- Main Navigation (Left) -->
        <nav class="flex gap-8">
          <NuxtLink to="/" :class="$route.path === '/' ? 'text-primary' : 'text-secondary'" class="text-sm font-medium hover:text-primary transition-colors duration-200">
            Request
          </NuxtLink>
          <NuxtLink to="/store" :class="$route.path === '/store' ? 'text-primary' : 'text-secondary'" class="text-sm font-medium hover:text-primary transition-colors duration-200">
            Store
          </NuxtLink>
          <NuxtLink to="/logs" :class="$route.path === '/logs' ? 'text-primary' : 'text-secondary'" class="text-sm font-medium hover:text-primary transition-colors duration-200">
            Logs
          </NuxtLink>
          <NuxtLink to="/tools" :class="$route.path === '/tools' ? 'text-primary' : 'text-secondary'" class="text-sm font-medium hover:text-primary transition-colors duration-200">
            Tools
          </NuxtLink>
          <NuxtLink to="/prompts" :class="$route.path === '/prompts' ? 'text-primary' : 'text-secondary'" class="text-sm font-medium hover:text-primary transition-colors duration-200">
            Prompts
          </NuxtLink>
        </nav>

        <!-- Right Side Controls -->
        <div class="flex items-center gap-6">
          <!-- Status Dot -->
          <ClientOnly>
            <div class="relative group">
              <span :class="['w-4 h-4 rounded-full border border-white/20', statusColor, 'block']"></span>
              <div class="hidden group-hover:block absolute right-0 top-full mt-2 bg-gray-950 border border-gray-700 rounded-lg p-2 text-xs text-gray-300 z-50 space-y-1 min-w-max">
                <div class="font-semibold text-gray-400 mb-1">Databases</div>
                <div><span :class="['w-2 h-2 rounded-full inline-block mr-2', health.databases.mongodb.ok ? 'bg-green-500' : 'bg-red-500']"></span>MongoDB<span v-if="health.databases.mongodb.error" class="text-gray-500 ml-2">{{ health.databases.mongodb.error }}</span></div>
                <div><span :class="['w-2 h-2 rounded-full inline-block mr-2', health.databases.firebase.ok ? 'bg-green-500' : 'bg-red-500']"></span>Firebase<span v-if="health.databases.firebase.error" class="text-gray-500 ml-2">{{ health.databases.firebase.error }}</span></div>
                <div><span :class="['w-2 h-2 rounded-full inline-block mr-2', health.databases.neo4j.ok ? 'bg-green-500' : 'bg-red-500']"></span>Neo4j<span v-if="health.databases.neo4j.error" class="text-gray-500 ml-2">{{ health.databases.neo4j.error }}</span></div>
                <div class="font-semibold text-gray-400 mt-2 mb-1">Services</div>
                <div><span :class="['w-2 h-2 rounded-full inline-block mr-2', health.pubsub.ok ? 'bg-green-500' : 'bg-red-500']"></span>Pub/Sub<span v-if="health.pubsub.error" class="text-gray-500 ml-2">{{ health.pubsub.error }}</span></div>
                <div v-if="Object.keys(health.models).length > 0" class="font-semibold text-gray-400 mt-2 mb-1">Models</div>
                <div v-for="(model, name) in health.models" :key="name"><span :class="['w-2 h-2 rounded-full inline-block mr-2', model.ok ? 'bg-green-500' : 'bg-red-500']"></span>{{ name }}<span v-if="model.error" class="text-gray-500 ml-2">{{ model.error }}</span></div>
              </div>
            </div>
          </ClientOnly>
          <!-- Theme Toggle Switch -->
          <ClientOnly>
            <button
              @click="toggleTheme"
              class="relative inline-flex h-7 w-12 items-center rounded-full bg-gray-400 transition hover:ring-2 hover:ring-amber-500/50 focus:outline-none"
              :aria-label="`Switch to ${isDark ? 'light' : 'dark'} mode`"
              title="Toggle theme"
            >
              <span
                :class="[
                  'inline-flex h-6 w-6 transform items-center justify-center rounded-full bg-white transition text-base font-bold',
                  isDark ? 'translate-x-5 text-gray-900' : 'translate-x-0.5 text-amber-500'
                ]"
                aria-hidden="true"
              >
                {{ isDark ? '🌙' : '☀️' }}
              </span>
            </button>
          </ClientOnly>

          <NuxtLink
            to="/config"
            :class="$route.path === '/config' ? 'text-primary' : 'text-secondary'"
            class="hover:ring-2 hover:ring-amber-500/50 transition-colors duration-200 focus:outline-none rounded p-1"
            aria-label="Settings"
            title="Settings"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </NuxtLink>
        </div>
      </div>
    </header>

    <main class="flex-1 overflow-auto px-8 py-4">
      <slot />
    </main>

    <!-- Toast Notifications -->
    <ToastContainer />
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const { isDark, toggleTheme } = useTheme()

const currentEnv = ref('local')

const health = ref({
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
  if (health.value.databases.mongodb.ok) healthy++
  if (health.value.databases.firebase.ok) healthy++
  if (health.value.databases.neo4j.ok) healthy++
  if (health.value.pubsub.ok) healthy++
  if (healthy === total) return 'bg-green-500'
  if (healthy === 0) return 'bg-red-500'
  return 'bg-yellow-500'
})

const statusText = computed(() => {
  let healthy = 0
  let total = 4
  if (health.value.databases.mongodb.ok) healthy++
  if (health.value.databases.firebase.ok) healthy++
  if (health.value.databases.neo4j.ok) healthy++
  if (health.value.pubsub.ok) healthy++
  if (healthy === total) return 'All Services Online'
  if (healthy === 0) return 'No Services Online'
  return `${healthy}/${total} Services Online`
})

const checkHealth = async () => {
  try {
    const response = await $fetch(`/api/health?env=${currentEnv.value}`)
    health.value = response
  } catch (error) {
    health.value = {
      databases: {
        mongodb: { ok: false, error: 'Check failed' },
        firebase: { ok: false, error: 'Check failed' },
        neo4j: { ok: false, error: 'Check failed' }
      },
      pubsub: { ok: false, error: 'Check failed' },
      models: {}
    }
  }
}

// Self-cancelling, non-overlapping poll — clears on unmount (HMR-safe) and
// won't stack requests if /api/health is slow.
usePoll(checkHealth, 5000)

watch(currentEnv, () => {
  checkHealth()
})
</script>
