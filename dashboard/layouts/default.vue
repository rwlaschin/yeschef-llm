<template>
  <div class="h-screen flex flex-col transition-colors duration-300">
    <header class="sticky top-0 z-40 app-header backdrop-blur-md">
      <div class="max-w-full px-6 py-4 flex items-center justify-between">
        <!-- Main Navigation (Left) -->
        <!-- Desktop nav — grouped dropdowns; collapses to a hamburger menu below lg -->
        <nav class="hidden lg:flex gap-8">
          <div
            v-for="g in groups"
            :key="g.label"
            class="flex items-center gap-1"
          >
            <!-- Active item name — navigates to the active page -->
            <NuxtLink
              :to="activeItem(g).to"
              :class="isGroupActive(g) ? 'text-primary' : 'text-secondary'"
              class="text-sm font-medium hover:text-primary transition-colors duration-200"
            >{{ activeItem(g).label }}</NuxtLink>
            <!-- Chevron — opens the portal submenu -->
            <button
              type="button"
              :ref="el => setTriggerRef(g.label, el)"
              class="grid place-items-center w-5 h-5 rounded text-secondary hover:text-primary transition-colors focus:outline-none"
              :aria-expanded="openGroup === g.label"
              :aria-label="`Open ${g.label} menu`"
              @click="toggleGroup(g.label)"
            >
              <ChevronDownIcon class="w-3.5 h-3.5 transition-transform duration-200" :class="openGroup === g.label ? 'rotate-180' : ''" />
            </button>
          </div>
        </nav>

        <!-- Portal submenu — teleported so it escapes the header stacking context -->
        <Teleport to="body">
          <div
            v-if="openGroup"
            class="fixed inset-0 z-[60]"
            @click="openGroup = null"
          >
            <div
              class="absolute surface-overlay rounded-lg py-1.5 shadow-xl min-w-44"
              :style="menuStyle"
              @click.stop
            >
              <NuxtLink
                v-for="item in openGroupItems"
                :key="item.to"
                :to="item.to"
                :class="$route.path === item.to ? 'text-primary' : 'text-secondary'"
                class="block px-4 py-2 text-sm font-medium hover:text-primary hover:bg-amber-400/10 transition-colors"
                @click="onSubmenuClick(openGroup, item)"
              >{{ item.label }}</NuxtLink>
            </div>
          </div>
        </Teleport>

        <!-- Mobile hamburger — shown on narrow screens -->
        <button
          type="button"
          class="lg:hidden grid place-items-center w-9 h-9 rounded-lg text-secondary hover:text-primary hover:bg-amber-400/10 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 transition"
          :aria-expanded="mobileOpen"
          aria-label="Toggle navigation menu"
          @click="mobileOpen = !mobileOpen"
        >
          <Bars3Icon v-if="!mobileOpen" class="w-6 h-6" />
          <XMarkIcon v-else class="w-6 h-6" />
        </button>

        <!-- Right Side Controls -->
        <div class="flex items-center gap-6">
          <!-- Account -->
          <ClientOnly>
            <button v-if="authUser" @click="onLogout" :title="authUser.email || 'Sign out'"
              class="text-sm text-secondary hover:text-primary transition-colors">Sign out</button>
          </ClientOnly>
          <!-- Status Dot -->
          <ClientOnly>
            <div class="relative group cursor-pointer" @click="navigateTo('/config')" title="Open settings">
              <HealthRing :segments="segments" :size="22" />
              <div class="hidden group-hover:block absolute right-0 top-full mt-2 w-80 surface-overlay rounded-lg p-3 text-xs text-secondary z-50 space-y-1.5 before:content-[''] before:absolute before:-top-2 before:left-0 before:right-0 before:h-2">
                <div class="font-semibold text-gray-400 mb-1">Databases</div>
                <div class="flex items-start gap-2">
                  <span class="w-2 h-2 rounded-full mt-1 shrink-0" :class="health.databases.mongodb.ok ? 'bg-green-500' : 'bg-red-500'"></span>
                  <div class="min-w-0"><div>MongoDB</div><div v-if="health.databases.mongodb.error" class="text-gray-500 line-clamp-3 break-words" :title="health.databases.mongodb.error">{{ health.databases.mongodb.error }}</div></div>
                </div>
                <div class="flex items-start gap-2">
                  <span class="w-2 h-2 rounded-full mt-1 shrink-0" :class="health.databases.firebase.ok ? 'bg-green-500' : 'bg-red-500'"></span>
                  <div class="min-w-0"><div>Firebase</div><div v-if="health.databases.firebase.error" class="text-gray-500 line-clamp-3 break-words" :title="health.databases.firebase.error">{{ health.databases.firebase.error }}</div></div>
                </div>
                <div class="flex items-start gap-2">
                  <span class="w-2 h-2 rounded-full mt-1 shrink-0" :class="health.databases.neo4j.ok ? 'bg-green-500' : 'bg-red-500'"></span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span>Neo4j</span>
                      <button v-if="!health.databases.neo4j.ok" @click.stop="resumeNeo4j" :disabled="resuming"
                        class="text-[11px] leading-none px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50 transition shrink-0">
                        {{ resuming ? 'Resuming…' : 'Resume' }}
                      </button>
                    </div>
                    <div v-if="health.databases.neo4j.error" class="text-gray-500 line-clamp-3 break-words" :title="health.databases.neo4j.error">{{ health.databases.neo4j.error }}</div>
                  </div>
                </div>
                <div class="font-semibold text-gray-400 mt-2 mb-1">Services</div>
                <div class="flex items-start gap-2">
                  <span class="w-2 h-2 rounded-full mt-1 shrink-0" :class="health.pubsub.ok ? 'bg-green-500' : 'bg-red-500'"></span>
                  <div class="min-w-0"><div>Pub/Sub</div><div v-if="health.pubsub.error" class="text-gray-500 line-clamp-3 break-words" :title="health.pubsub.error">{{ health.pubsub.error }}</div></div>
                </div>
                <div class="flex items-start gap-2">
                  <span class="w-2 h-2 rounded-full mt-1 shrink-0" :class="health.orchestrator.ok ? 'bg-green-500' : 'bg-red-500'"></span>
                  <div class="min-w-0"><div>Orchestrator</div><div v-if="health.orchestrator.error" class="text-gray-500 line-clamp-3 break-words" :title="health.orchestrator.error">{{ health.orchestrator.error }}</div></div>
                </div>
                <div v-if="Object.keys(health.models).length > 0" class="font-semibold text-gray-400 mt-2 mb-1">Models</div>
                <div v-for="(model, name) in health.models" :key="name" class="flex items-start gap-2">
                  <span class="w-2 h-2 rounded-full mt-1 shrink-0" :class="model.ok ? 'bg-green-500' : 'bg-red-500'"></span>
                  <div class="min-w-0"><div>{{ name }}</div><div v-if="model.error" class="text-gray-500 line-clamp-3 break-words" :title="model.error">{{ model.error }}</div></div>
                </div>
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

      <!-- Mobile menu — stacked links, shown below lg when the hamburger is open -->
      <transition
        enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 -translate-y-1" enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-100 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0"
      >
        <nav v-show="mobileOpen" class="lg:hidden absolute left-0 right-0 top-full bg-white/95 dark:bg-gray-950/85 backdrop-blur-md border-b border-divider shadow-xl px-6 py-3 flex flex-col gap-1">
          <div v-for="g in groups" :key="g.label" class="py-1">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-400 px-2 pb-1">{{ g.label }}</div>
            <NuxtLink
              v-for="item in g.items"
              :key="item.to"
              :to="item.to"
              :class="$route.path === item.to ? 'text-primary' : 'text-secondary'"
              class="text-sm font-medium py-2 px-2 rounded-lg hover:text-primary hover:bg-amber-400/10 transition-colors block"
              @click="mobileOpen = false"
            >{{ item.label }}</NuxtLink>
          </div>
        </nav>
      </transition>
    </header>

    <main class="flex-1 overflow-auto px-8 py-4">
      <slot />
    </main>

    <!-- Toast Notifications -->
    <ToastContainer />
  </div>
</template>

<script setup>
import { Bars3Icon, XMarkIcon, ChevronDownIcon } from '@heroicons/vue/24/outline'

const { isDark, toggleTheme } = useTheme()
const route = useRoute()

const { user: authUser, logout } = useAuth()
const onLogout = async () => { await logout(); navigateTo('/login') }

// Grouped nav — single source, rendered in the desktop dropdowns and the mobile menu so they can't drift.
const groups = [
  { label: 'Queries', items: [
    { to: '/', label: 'Requests' },
    { to: '/menu', label: 'Menu Plans' },
  ] },
  { label: 'Configs', items: [
    { to: '/plan-library', label: 'Plans' },
    { to: '/prompts', label: 'Prompts' },
    { to: '/tools', label: 'Tools' },
    { to: '/model-config', label: 'Sampling' },
  ] },
  { label: 'Tools', items: [
    { to: '/store', label: 'Store' },
    { to: '/capacity', label: 'Capacity' },
    { to: '/logs', label: 'Logs' },
  ] },
]

// Per-group "last visited" submenu, keyed by group label; seeded to each group's first item.
const lastActive = ref(Object.fromEntries(groups.map(g => [g.label, g.items[0].to])))

const isGroupActive = (g) => g.items.some(i => i.to === route.path)
// Active item = current route if it's in this group, else the last-visited one.
const activeItem = (g) => {
  const current = g.items.find(i => i.to === route.path)
  if (current) return current
  return g.items.find(i => i.to === lastActive.value[g.label]) || g.items[0]
}
// Remember the current route as the active item for whichever group owns it.
watch(() => route.path, (p) => {
  const g = groups.find(gr => gr.items.some(i => i.to === p))
  if (g) lastActive.value[g.label] = p
}, { immediate: true })

// Portal submenu state — which group is open, its trigger button, and the resulting position.
const openGroup = ref(null)
const triggers = {}
const setTriggerRef = (label, el) => { if (el) triggers[label] = el }
const menuStyle = ref({})
const openGroupItems = computed(() => groups.find(g => g.label === openGroup.value)?.items || [])

const toggleGroup = (label) => {
  if (openGroup.value === label) { openGroup.value = null; return }
  const el = triggers[label]
  if (el) {
    const r = el.getBoundingClientRect()
    menuStyle.value = { top: `${r.bottom + 8}px`, left: `${r.left}px` }
  }
  openGroup.value = label
}
const onSubmenuClick = (label, item) => {
  lastActive.value[label] = item.to
  openGroup.value = null
}

const mobileOpen = ref(false)

// Single source of truth — see composables/useHealth.ts. One poll loop app-wide;
// this just reads the shared state. `segments` = flat list of every check (core + models).
const { health, segments } = useHealth()

// Manual unpause for the AuraDB Free instance — appears on the Neo4j row when it's down.
const { env } = useEnvironment()
const resuming = ref(false)
async function resumeNeo4j() {
  if (resuming.value) return
  resuming.value = true
  try {
    await $fetch('/api/store/neo4j-resume', { method: 'POST', body: { env: env.value } })
  } catch (e) {
    console.error('[neo4j] resume failed:', e)
  } finally {
    resuming.value = false
  }
}
</script>
