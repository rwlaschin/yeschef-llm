<template>
  <div class="h-[calc(100vh-5.5rem)] flex flex-col min-h-0 glass p-5 gap-4 overflow-hidden">
    <!-- 1. PINNED TOP BAR: Header + Active Card Row (NEVER scrolls away) -->
    <div class="shrink-0 space-y-4">
      <!-- Title & Global Actions -->
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-serif text-primary">Fleet & Servers</h1>
          <span class="px-2.5 py-0.5 rounded-full text-xs font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            {{ activeCount }} Active · Today: {{ todayTotalFormatted }}
          </span>
        </div>

        <!-- Header Actions: Always reachable in 1 click -->
        <div class="flex items-center gap-2 font-mono text-xs">
          <button
            type="button"
            @click="stopAll"
            :disabled="activeCount === 0 || stoppingAll"
            class="flex items-center gap-1.5 px-3.5 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition disabled:opacity-30 disabled:cursor-not-allowed font-medium"
          >
            <StopIcon class="w-4 h-4" />
            {{ stoppingAll ? 'Stopping…' : 'Stop All' }}
          </button>

          <button
            type="button"
            @click="fetchFleet"
            :disabled="loading"
            class="flex items-center gap-1.5 px-3.5 py-2 btn-muted rounded-lg font-medium transition"
          >
            <ArrowPathIcon class="w-4 h-4" :class="{ 'animate-spin': loading }" />
            Refresh
          </button>
        </div>
      </div>

      <!-- Card Row: Pinned Active Node Cards (Centered, Fixed Height, Compact) -->
      <div class="flex items-center justify-center gap-2.5 min-w-0 pb-1 pt-1 w-full min-h-[92px] h-[92px]">
        <template v-if="activeBoxes.length > 0">
          <div
            v-for="b in activeBoxes"
            :key="b.name"
            class="relative h-full px-3 py-2 rounded-2xl border border-white/[0.12] bg-gradient-to-b from-white/[0.07] to-white/[0.02] backdrop-blur-xl flex flex-col justify-between flex-1 min-w-[155px] max-w-[210px] shrink font-mono text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_rgba(0,0,0,0.45)] hover:border-white/[0.22] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_12px_32px_rgba(0,0,0,0.6)] transition-all duration-300"
          >
            <!-- Row 1: Status Dot + Name (left), Cost (right) -->
            <div class="flex items-center justify-between gap-1.5 pb-1 border-b border-white/5">
              <div class="flex items-center gap-2">
                <span class="relative flex h-2.5 w-2.5 shrink-0">
                  <!-- Only pulse on IDLE machines (0% GPU) -->
                  <span
                    v-if="b.gpuPercent === 0 && b.status !== 'STARTING' && actionState[b.name] !== 'starting'"
                    class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-red-400"
                  ></span>
                  <span
                    class="relative inline-flex rounded-full h-2.5 w-2.5"
                    :class="(b.status === 'STARTING' || actionState[b.name] === 'starting') ? 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]' : b.gpuPercent > 0 ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]' : b.gpuPercent === 0 ? 'bg-red-400 shadow-[0_0_10px_rgba(239,68,68,0.9)]' : 'bg-slate-500'"
                  ></span>
                </span>
                <span class="font-bold text-white text-xs tracking-wider drop-shadow-sm truncate">{{ b.name }}</span>
                <span class="text-white/20 text-xs">|</span>
                <span class="text-white/70 text-[11px] font-semibold tabular-nums">
                  {{ b.todayCostFormatted || ('$' + (b.todayCost ?? 0).toFixed(2)) }}
                </span>
              </div>
            </div>

            <!-- Row 2: Metric + Load Bar (left) + Stop Button (right) -->
            <div class="flex items-center justify-between gap-2 pt-0.5">
              <!-- Metric + Bar Container -->
              <div class="flex-1 flex flex-col gap-1 min-w-0">
                <div class="text-[11px] font-semibold tabular-nums" :class="b.gpuPercent > 0 ? 'text-emerald-400' : b.gpuPercent === 0 ? 'text-red-400' : 'text-white/40'">
                  <!-- The live phase (hunting/created/booting/installing/pulling) says where the
                       start actually is; a fixed "STARTING…" tells the user nothing for minutes. -->
                  <span v-if="b.status === 'STARTING' || actionState[b.name] === 'starting'" class="text-amber-400 animate-pulse text-[10px] uppercase">{{ PHASE_LABEL[b.startupProgress?.phase] || 'Starting' }}…</span>
                  <!-- Label first in BOTH states: reading "GPU ··" then "0% GPU" looks like two
                       different fields rather than one field that got a value. -->
                  <span v-else>GPU <span :class="b.gpuPercent == null ? 'text-white/40' : ''">{{ b.gpuPercent != null ? b.gpuPercent + '%' : '··' }}</span></span>
                </div>

                <div class="w-full bg-black/40 backdrop-blur-sm rounded-full h-1.5 overflow-hidden border border-white/[0.08] shadow-inner">
                  <div
                    v-if="b.status === 'STARTING' || actionState[b.name] === 'starting'"
                    class="h-full rounded-full bg-gradient-to-r from-amber-600 via-amber-400 to-yellow-300 animate-pulse shadow-[0_0_10px_rgba(251,191,36,0.8)] w-full"
                  />
                  <div
                    v-else
                    class="h-full rounded-full transition-all duration-500"
                    :class="b.gpuPercent > 0 ? 'bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-300 shadow-[0_0_10px_rgba(52,211,153,0.8)]' : 'bg-gradient-to-r from-red-600 via-rose-500 to-orange-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]'"
                    :style="{ width: b.gpuPercent > 0 ? `${b.gpuPercent}%` : b.gpuPercent === 0 ? '100%' : '0%' }"
                  />
                </div>
              </div>

              <!-- Stop / Cancel Button -->
              <button
                type="button"
                @click="stopBox(b.name)"
                :disabled="actionState[b.name] === 'stopping'"
                class="px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-all font-mono shrink-0 active:scale-95"
                :class="actionState[b.name] === 'stopping'
                  ? 'bg-white/[0.02] border border-white/[0.06] text-white/25 cursor-not-allowed'
                  : (b.status === 'STARTING' || actionState[b.name] === 'starting')
                    ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 hover:text-amber-200 border border-amber-500/40 shadow-[0_0_8px_rgba(251,191,36,0.2)]'
                    : (b.gpuPercent || 0) > 0
                      ? 'bg-white/[0.04] border border-white/[0.1] text-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-red-500/20 hover:border-red-400/40 hover:text-red-300 hover:shadow-[0_0_8px_rgba(239,68,68,0.2)]'
                      : 'bg-gradient-to-b from-red-500/30 to-red-600/15 border border-red-400/50 text-red-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_2px_10px_rgba(239,68,68,0.35)] hover:from-red-500/45 hover:to-red-600/30 hover:border-red-400/80 animate-pulse'"
              >
                {{ (b.status === 'STARTING' || actionState[b.name] === 'starting') ? 'Cancel' : 'Stop' }}
              </button>
            </div>
          </div>
        </template>
        <div v-else class="h-full flex items-center justify-center px-6 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] backdrop-blur-md text-xs text-muted font-mono gap-2.5">
          <span class="w-2.5 h-2.5 rounded-full bg-gray-600"></span>
          <span>No active VM instances running — start an instance in the Control Panel below</span>
        </div>
      </div>
    </div>

    <!-- 2. WORKSPACE AREA: Sidebar + Scrollable Table / Logs -->
    <div class="flex-1 flex gap-2.5 min-h-0 overflow-hidden relative">
      <!-- Left Sidebar Container -->
      <div
        class="relative shrink-0 z-30 transition-all duration-200"
        :class="isMinimalMode ? 'w-10' : 'w-44'"
        @mouseenter="onSidebarMouseEnter"
        @mouseleave="onSidebarMouseLeave"
      >
        <!-- Actual Sidebar Panel (Fixed width when expanded, floats over content when in minimal flyout mode) -->
        <div
          class="flex flex-col justify-between surface-2 rounded-xl border border-divider font-mono text-xs transition-all duration-200 select-none h-full"
          :class="[
            isMinimalMode && !isFlyoutOpen
              ? 'w-10 items-center p-1.5'
              : 'w-44 p-2.5 shadow-2xl backdrop-blur-md',
            isMinimalMode && isFlyoutOpen ? 'absolute top-0 left-0 z-40 surface-overlay' : ''
          ]"
        >
          <div class="space-y-1.5 w-full">
            <!-- Header: Title + Collapse/Expand Toggle -->
            <div class="flex items-center justify-between" :class="isMinimalMode && !isFlyoutOpen ? 'justify-center mb-1' : 'px-1 mb-1'">
              <span v-if="!isMinimalMode || isFlyoutOpen" class="text-[10px] text-muted uppercase tracking-wider font-semibold">Views</span>
              <button
                type="button"
                @click="toggleSidebarManual"
                class="p-1 rounded-md text-secondary hover:text-primary hover:bg-white/5 transition"
                :class="!isMinimalMode || isFlyoutOpen ? 'ml-auto' : ''"
                :title="isMinimalMode ? 'Lock expanded' : 'Collapse to icon bar'"
              >
                <Bars3Icon v-if="isMinimalMode && !isFlyoutOpen" class="w-4 h-4" />
                <ChevronDoubleLeftIcon v-else class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Tab 1: Control Panel -->
            <button
              type="button"
              @click="selectView('control')"
              class="w-full text-left rounded-lg transition flex items-center text-xs"
              :class="[
                activeView === 'control' ? 'row-active font-semibold' : 'text-secondary hover:text-primary hover:bg-white/5',
                isMinimalMode && !isFlyoutOpen ? 'justify-center p-1.5' : 'justify-between px-2.5 py-2'
              ]"
              :title="isMinimalMode && !isFlyoutOpen ? `Control Panel (${boxes.length})` : undefined"
            >
              <div class="flex items-center gap-2.5">
                <ServerIcon class="w-4 h-4 shrink-0" />
                <span v-if="!isMinimalMode || isFlyoutOpen" class="truncate">Control Panel</span>
              </div>
              <span v-if="!isMinimalMode || isFlyoutOpen" class="text-[10px] px-1.5 py-0.5 rounded bg-black/20 text-muted shrink-0">{{ boxes.length }}</span>
            </button>

            <!-- Tab 2: Device Logs -->
            <button
              type="button"
              @click="selectView('logs')"
              class="w-full text-left rounded-lg transition flex items-center text-xs"
              :class="[
                activeView === 'logs' ? 'row-active font-semibold' : 'text-secondary hover:text-primary hover:bg-white/5',
                isMinimalMode && !isFlyoutOpen ? 'justify-center p-1.5' : 'justify-between px-2.5 py-2'
              ]"
              :title="isMinimalMode && !isFlyoutOpen ? 'Device Logs' : undefined"
            >
              <div class="flex items-center gap-2.5">
                <CommandLineIcon class="w-4 h-4 shrink-0" />
                <span v-if="!isMinimalMode || isFlyoutOpen" class="truncate">Device Logs</span>
              </div>
              <span v-if="!isMinimalMode || isFlyoutOpen" class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
            </button>
          </div>
        </div>
      </div>

      <!-- Right Main Content Area (Internally scrollable) -->
      <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
        <!-- TAB 1: FLEET CONTROL PANEL -->
        <div v-if="activeView === 'control'" class="flex-1 rounded-xl border border-divider overflow-auto surface-2 flex flex-col">
          <!-- table-fixed + proportional columns: with auto layout the intrinsic min-content width of
               8 padded columns exceeds the container, so the table kept its size and the wrapper
               scrolled sideways, clipping ACTIONS. Fixed layout makes the columns follow the window. -->
          <table class="w-full table-fixed text-left text-xs border-collapse font-mono">
            <colgroup>
              <col style="width: 10%" /><col style="width: 15%" /><col style="width: 9%" />
              <col style="width: 16%" /><col style="width: 15%" /><col style="width: 11%" />
              <col style="width: 10%" /><col style="width: 14%" />
            </colgroup>
            <thead class="sticky top-0 z-10 surface-solid text-secondary text-xs uppercase border-b border-divider font-medium shadow-sm">
              <tr>
                <th class="py-3 px-3">Status</th>
                <th class="py-3 px-3">VM Instance</th>
                <th class="py-3 px-3">GPU Load</th>
                <th class="py-3 px-3">VRAM</th>
                <th class="py-3 px-3">Model</th>
                <th class="py-3 px-3">Auto-Stop</th>
                <th class="py-3 px-3">Today's Cost</th>
                <th class="py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-xs">
                <tr
                  v-for="(b, idx) in sortedBoxes"
                  :key="b.name"
                  class="relative transition"
                  :class="b.status === 'RUNNING' && b.gpuPercent === 0
                    ? 'bg-red-500/10 hover:bg-red-500/15 border-l-2 border-l-red-500'
                    : (idx % 2 === 1 ? 'bg-white/[0.025] hover:bg-white/[0.06]' : 'hover:bg-white/[0.04]')"
                >
                  <!-- Status -->
                  <!-- STARTING takes the whole row: one cell spanning every column, so it tracks table width -->
                  <td
                    v-if="b.status === 'STARTING' || actionState[b.name] === 'starting'"
                    colspan="8"
                    class="p-0"
                  >
                    <div class="w-full flex items-center justify-between gap-3 px-4 py-3 bg-amber-500/10 border-y border-amber-500/40 text-xs font-mono text-slate-200">
                      <div class="flex items-center gap-3 min-w-0">
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs bg-amber-500/20 text-amber-400 border border-amber-500/40 font-medium shrink-0">
                          STARTING
                        </span>
                        <span v-if="b.startupProgress?.phase" class="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-300 font-bold uppercase tracking-wider shrink-0 font-sans">
                          {{ PHASE_LABEL[b.startupProgress.phase] || b.startupProgress.phase }}
                        </span>
                        <span class="flex items-center gap-2 text-amber-200 font-medium min-w-0">
                          <!-- animate-ping scales to 2x, so the ring needs its own box outside the
                               truncate below — truncate sets overflow:hidden and shears it off. -->
                          <span class="relative flex w-1.5 h-1.5 mx-1 shrink-0">
                            <span class="absolute inline-flex w-full h-full rounded-full bg-amber-400 opacity-75 animate-ping"></span>
                            <span class="relative inline-flex w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                          </span>
                          <span class="truncate">{{ b.name }} · {{ b.startupProgress?.msg || 'Probing L4 GPU capacity across US zones…' }}</span>
                        </span>
                      </div>
                      <button
                        type="button"
                        @click="stopBox(b.name)"
                        class="p-1.5 bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition disabled:opacity-40 shadow-sm"
                      >
                        <StopIcon class="w-3.5 h-3.5 fill-current" />
                        <!--span>Cancel</span-->
                      </button>
                    </div>
                  </td>

                  <td v-else class="py-3 px-3 whitespace-nowrap">
                    <!-- A delete takes tens of seconds, and the box reads RUNNING for all of it, so
                         this has to win over RUNNING or the click looks like it did nothing. -->
                    <span
                      v-if="b.status === 'STOPPING' || actionState[b.name] === 'stopping'"
                      class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs bg-orange-500/20 text-orange-300 border border-orange-500/40 font-medium animate-pulse"
                      title="Instance is being deleted — it still exists and still bills until this finishes"
                    >
                      STOPPING…
                    </span>
                    <span
                      v-else-if="b.status === 'RUNNING'"
                      class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-medium"
                    >
                      RUNNING
                    </span>
                    <span
                      v-else
                      class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs bg-gray-500/15 text-muted border border-divider font-medium"
                    >
                      STOPPED
                    </span>
                  </td>

                  <!-- VM Instance Name -->
                  <td v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" class="py-3 px-3 font-semibold text-strong">
                    {{ b.vm || ('yc-ollama-' + b.name) }}
                  </td>

                  <!-- GPU Load (No dot, no words: Green >0%, Red 0% Idle) -->
                  <td v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" class="py-3 px-3 tabular-nums font-mono text-xs">
                    <span
                      v-if="b.status === 'RUNNING' && b.gpuPercent != null"
                      :class="b.gpuPercent > 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'"
                    >
                      {{ b.gpuPercent }}%
                    </span>
                    <span v-else-if="b.status === 'RUNNING'" class="text-muted" :title="b.gpuLoad?.formatted || 'sampling'">
                      ··
                    </span>
                    <span v-else class="text-muted">-</span>
                  </td>

                  <!-- VRAM Allocation -->
                  <td v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" class="py-3 px-3">
                    <div v-if="b.status === 'RUNNING'" class="space-y-1">
                      <div class="flex justify-between text-[11px]">
                        <span class="text-secondary">{{ b.vram?.usedGb || '0' }} / 24 GB</span>
                        <span class="text-emerald-400 font-medium">{{ b.vram?.percent || 0 }}%</span>
                      </div>
                      <div class="w-full bg-black/40 rounded-full h-1.5 overflow-hidden border border-white/5">
                        <div
                          class="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-300 shadow-[0_0_6px_rgba(52,211,153,0.6)] transition-all duration-300"
                          :style="{ width: `${b.vram?.percent || 0}%` }"
                        ></div>
                      </div>
                    </div>
                    <span v-else class="text-muted">-</span>
                  </td>

                  <!-- Model: chosen here before start, locked once the box owns one -->
                  <td v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" class="py-3 px-3 font-mono text-xs">
                    <select
                      v-if="b.status === 'STOPPED'"
                      :value="selectedModel[b.name] ?? defaultModel"
                      @change="selectedModel[b.name] = $event.target.value"
                      class="surface-2 text-strong border border-divider px-2.5 py-1 rounded-lg text-xs font-mono w-full focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
                    </select>
                    <!-- Same px/py/border metrics as the select above, border transparent: the locked
                         value has to sit on the same text baseline and left edge as the dropdowns it
                         replaces, without drawing another box around it. -->
                    <span v-else-if="b.loadedModels?.length" class="inline-block px-2.5 py-1 border border-transparent text-emerald-400 font-medium" title="loaded in VRAM">
                      {{ b.loadedModels[0] }}
                    </span>
                    <span v-else-if="b.models?.length" class="inline-block px-2.5 py-1 border border-transparent text-muted" title="on disk, not loaded into VRAM">
                      {{ b.models[0] }}
                    </span>
                    <span v-else class="inline-block px-2.5 py-1 border border-transparent text-muted" :title="`pulling ${selectedModel[b.name] ?? defaultModel}…`">
                      {{ selectedModel[b.name] ?? defaultModel }}
                    </span>
                  </td>

                  <!-- Auto-Stop Selector -->
                  <td v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" class="py-3 px-3">
                    <select
                      :value="autoShutdown[b.name] || 15"
                      @change="autoShutdown[b.name] = Number($event.target.value)"
                      class="surface-2 text-strong border border-divider px-2.5 py-1 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      <!-- No "Off": 0 disables the watchdog entirely and the box bills until someone
                           remembers it. Every value here still ends in a self-delete. -->
                      <option :value="2">2m</option>
                      <option :value="5">5m</option>
                      <option :value="15">15m</option>
                      <option :value="30">30m</option>
                    </select>
                  </td>

                  <!-- Today's Cost Accumulation -->
                  <td
                    v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" 
                    class="py-3 px-3 font-semibold text-primary tabular-nums whitespace-nowrap"
                    :title="b.runCost > 0 ? `${b.runCostFormatted} this run` : 'today total'"
                  >
                    {{ b.todayCostFormatted || ('$' + (b.todayCost ?? 0).toFixed(2)) }}
                  </td>

                  <!-- Actions -->
                  <td v-if="!(b.status === 'STARTING' || actionState[b.name] === 'starting')" class="py-3 px-3 text-right whitespace-nowrap">
                    <div class="flex items-center justify-end">
                      <button
                        v-if="b.status === 'STARTING' || actionState[b.name] === 'starting'"
                        type="button"
                        disabled
                        class="px-2 py-1 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg animate-pulse font-mono"
                        title="Starting"
                      >
                        …
                      </button>
                      <button
                        v-else-if="b.status === 'STOPPED'"
                        type="button"
                        @click="startBox(b.name)"
                        class="p-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition shadow-sm"
                        title="Start"
                        aria-label="Start"
                      >
                        <PlayIcon class="w-3.5 h-3.5 fill-current" />
                      </button>
                      <button
                        v-else
                        type="button"
                        @click="stopBox(b.name)"
                        :disabled="actionState[b.name] === 'stopping' || b.status === 'STOPPING'"
                        class="p-1.5 bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition disabled:opacity-40 shadow-sm"
                        title="Stop"
                        aria-label="Stop"
                      >
                        <StopIcon class="w-3.5 h-3.5 fill-current" />
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
        </div>

        <!-- TAB 2: DEVICE LOGS (Scoped strictly to devbox instances) -->
        <div v-else class="flex-1 min-h-0 h-full flex flex-col surface-2 rounded-xl border border-divider p-4 space-y-3 font-mono">
          <!-- Log Controls -->
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <!-- Device Selector Dropdown -->
            <div class="relative">
              <select
                v-model="selectedLogDevice"
                aria-label="Device Source"
                class="appearance-none surface-solid text-strong border border-divider pl-3 pr-8 py-1.5 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                <option value="all">All MIGs</option>
                <option v-for="b in boxes" :key="b.name" :value="b.name">yc-ollama-{{ b.name }}</option>
              </select>
              <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted text-[10px]">▼</span>
            </div>

            <!-- Cumulative Level Filter -->
            <div class="flex rounded-lg overflow-hidden border border-divider text-xs">
              <button
                v-for="lvl in ['ALL', 'INF', 'WRN', 'ERR']"
                :key="lvl"
                type="button"
                @click="logLevel = lvl"
                :class="[
                  'px-2.5 py-1 transition font-mono',
                  logLevel === lvl ? 'bg-amber-500 text-gray-900 font-bold' : 'surface-solid text-secondary hover:text-primary'
                ]"
              >
                {{ lvl }}
              </button>
            </div>

            <!-- Search Query Filter -->
            <input
              v-model="logFilter"
              type="text"
              placeholder="Filter device logs…"
              class="flex-1 min-w-[8rem] surface-solid text-strong placeholder-muted border border-divider px-3 py-1.5 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
            />

            <!-- Live Tail Toggle -->
            <button
              type="button"
              @click="autoScroll = !autoScroll"
              :class="[
                'px-3 py-1.5 rounded-lg text-xs border transition flex items-center gap-1.5 font-mono',
                autoScroll ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 font-medium' : 'surface-solid border-divider text-muted'
              ]"
            >
              <span :class="['w-1.5 h-1.5 rounded-full', autoScroll ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500']" />
              {{ autoScroll ? 'Live' : 'Paused' }}
            </button>

            <!-- Clear Button -->
            <button
              type="button"
              @click="clearDeviceLogs"
              class="px-3 py-1.5 rounded-lg text-xs btn-muted transition font-mono"
            >
              Clear
            </button>
          </div>

          <!-- Log Stream Container (Fills remaining height completely to the bottom) -->
          <div
            ref="logContainer"
            @scroll="onLogScroll"
            class="flex-1 min-h-0 overflow-y-auto p-3.5 font-mono text-xs surface-solid text-secondary rounded-lg space-y-1.5 select-text border border-divider"
          >
            <div v-for="(log, idx) in visibleDeviceLogs" :key="idx" class="leading-relaxed flex items-start gap-2.5">
              <span class="text-muted text-[11px] shrink-0 tabular-nums">{{ formatLogTimestamp(log.timestamp) }}</span>
              <span class="text-primary font-semibold text-[11px] shrink-0">[{{ log.device }}]</span>
              <span
                class="text-[10px] px-1.5 py-0.2 rounded font-bold uppercase shrink-0"
                :class="log.level === 'ERR' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : log.level === 'WRN' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'"
              >
                {{ log.level }}
              </span>
              <span class="text-strong break-all">{{ log.msg }}</span>
            </div>
            <div v-if="visibleDeviceLogs.length === 0" class="text-muted italic py-16 text-center text-xs">
              No device log entries found for: {{ selectedLogDevice === 'all' ? 'All MIGs' : `yc-ollama-${selectedLogDevice}` }}.
            </div>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  XMarkIcon,
  GlobeAltIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  Bars3Icon,
  ServerIcon,
  CommandLineIcon
} from '@heroicons/vue/24/outline'
import {
  PlayIcon,
  StopIcon
} from '@heroicons/vue/24/solid'
import { nextTick, ref, computed, onMounted, onUnmounted } from 'vue'

const activeView = ref('control')

// Responsive minimal mode (collapses to icon bar on screens < 1024px or when toggled manually)
const isNarrowScreen = ref(false)
const manualCollapsed = ref(null) // null = follow screen size, boolean = user override
const isMinimalMode = computed(() => {
  if (manualCollapsed.value !== null) return manualCollapsed.value
  return isNarrowScreen.value
})

const isFlyoutOpen = ref(false)
let flyoutLeaveTimer = null

const onSidebarMouseEnter = () => {
  if (isMinimalMode.value) {
    if (flyoutLeaveTimer) clearTimeout(flyoutLeaveTimer)
    isFlyoutOpen.value = true
  }
}

const onSidebarMouseLeave = () => {
  if (isMinimalMode.value) {
    flyoutLeaveTimer = setTimeout(() => {
      isFlyoutOpen.value = false
    }, 200)
  }
}

const toggleSidebarManual = () => {
  if (manualCollapsed.value === null) {
    manualCollapsed.value = !isNarrowScreen.value
  } else {
    manualCollapsed.value = !manualCollapsed.value
  }
  isFlyoutOpen.value = false
}

const selectView = (view) => {
  activeView.value = view
  if (isMinimalMode.value) {
    isFlyoutOpen.value = false
  }
}

const updateScreenSize = () => {
  if (typeof window !== 'undefined') {
    isNarrowScreen.value = window.innerWidth < 1024
  }
}

const DEFAULT_BOXES = ['001', '002', '003', '004'].map((name) => ({
  name,
  vm: `yc-ollama-${name}`,
  status: 'STOPPED',
  gpuPercent: null,
  todayCost: 0,
  todayCostFormatted: '$0.00',
  vram: { usedGb: '0', percent: 0 },
  models: [],
  loadedModels: [],
}))

const boxes = ref(DEFAULT_BOXES)
const auth = ref({ ok: true, account: null })
const loading = ref(false)
const stoppingAll = ref(false)

const selectedLogDevice = ref('all')
const logLevel = ref('ALL')
const logFilter = ref('')
const autoScroll = ref(true)
const logContainer = ref(null)
const tailing = ref(true)

// Follow the tail, but never yank the view while someone reads history: scrolling away from the
// bottom pauses, returning to it resumes. Same behaviour as LogsViewer.
const onLogScroll = () => {
  const el = logContainer.value
  if (!el) return
  tailing.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
const deviceLogs = ref([])
// Cloud Logging lines are kept apart from locally-emitted events; the cloud fetch used to
// overwrite deviceLogs wholesale, silently erasing every start/progress line we had added.
const cloudLogs = ref([])
let logArrivalSequence = 0

function normalizeLogTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function formatLogTimestamp(timestamp) {
  const date = new Date(timestamp)
  const today = new Date()
  const time = date.toLocaleTimeString('en-US', { hour12: false })
  if (date.toDateString() === today.toDateString()) return time
  return `${date.toLocaleDateString('en-US')} ${time}`
}

// devbox.js phase names, in the user's words rather than the script's.
const PHASE_LABEL = {
  preflight: 'Checking access',
  hunting: 'Searching',
  created: 'Allocated',
  booting: 'Booting',
  installing: 'Installing',
  pulling: 'Pulling model',
}

const actionState = ref({})
const startedAt = ref({})
// The box has no say in which model it runs — this dropdown is the only source, and it locks on
// start because the choice is baked in by the pull that happens during boot.
const selectedModel = ref({})
const workers = ref([])
const modelOptions = computed(() => [...new Set((workers.value || []).map(w => w.model))].sort())
// Alphabetical order put gemma first; llama3.1:8b is the intended default.
const defaultModel = computed(() =>
  modelOptions.value.find(m => m === 'llama3.1:8b') || modelOptions.value[0] || 'llama3.1:8b')
const autoShutdown = ref({
  '001': 5,
  '002': 5,
  '003': 5,
  '004': 5,
})

// STOPPING counts as active: the instance still exists and still bills until the delete lands, so
// dropping it to "0 Active · no instances running" understates what the user is paying for.
const activeBoxes = computed(() => boxes.value.filter(b => b.status === 'RUNNING' || b.status === 'STARTING' || b.status === 'STOPPING' || actionState.value[b.name] === 'starting' || actionState.value[b.name] === 'stopping'))
// Active rows always sort above stopped ones; ties keep name order.
const sortedBoxes = computed(() => {
  const activeNames = new Set(activeBoxes.value.map(b => b.name))
  const isActive = (b) => activeNames.has(b.name) ? 0 : 1
  return [...boxes.value].sort((a, b) => isActive(a) - isActive(b) || a.name.localeCompare(b.name))
})
const activeCount = computed(() => activeBoxes.value.length)
const todayTotalFormatted = computed(() => {
  const sum = boxes.value.reduce((acc, b) => acc + (b.todayCost || 0), 0)
  return `$${sum.toFixed(2)}`
})

const timestamp_sequence_order = (a, b) =>
  a.timestamp - b.timestamp || a.sequence - b.sequence

const visibleDeviceLogs = computed(() => {
  return [...cloudLogs.value, ...deviceLogs.value].filter(l => {
    if (selectedLogDevice.value !== 'all' && l.device !== selectedLogDevice.value) return false
    if (logLevel.value === 'INF' && !['INF', 'WRN', 'ERR'].includes(l.level)) return false
    if (logLevel.value === 'WRN' && !['WRN', 'ERR'].includes(l.level)) return false
    if (logLevel.value === 'ERR' && l.level !== 'ERR') return false
    if (logFilter.value && !l.msg.toLowerCase().includes(logFilter.value.toLowerCase())) return false
    return true
  }).sort(timestamp_sequence_order)
})

watch([visibleDeviceLogs, tailing, activeView], async () => {
  if (!tailing.value || activeView.value !== 'logs') return
  await nextTick()
  const el = logContainer.value
  if (el) el.scrollTop = el.scrollHeight
})

// Event-based: one EventSource while the Logs tab is open; the server pushes new lines.
let logStream = null

function appendCloudLines(lines) {
  const boxesByName = new Map(boxes.value.map(b => [String(b.name).padStart(3, '0'), b]))
  const parsed = lines
    .filter(l => l.module?.includes('gce') || l.msg?.includes('ollama') || l.msg?.includes('devbox') || l.msg?.includes('001') || l.msg?.includes('002'))
    .map(l => {
      const boxMatch = `${l.msg || ''} ${l.raw || ''}`.match(/yc-ollama-\d{1,3}|devbox-\d{1,3}|\[\d{1,3}\]/)
      const normalizedName = boxMatch?.[0]?.replace(/\D/g, '').padStart(3, '0')
      const matchedBox = normalizedName ? boxesByName.get(normalizedName) : null
      const timestamp = normalizeLogTimestamp(l.ts)
      return {
        ts: l.ts,
        timestamp,
        sequence: logArrivalSequence++,
        time: new Date(timestamp).toLocaleTimeString('en-US', { hour12: false }),
        device: matchedBox ? matchedBox.name : '001',
        level: l.level >= 50 ? 'ERR' : l.level >= 40 ? 'WRN' : 'INF',
        msg: l.msg
      }
    })
  if (parsed.length) cloudLogs.value = [...cloudLogs.value, ...parsed].slice(-500)
}

function openLogStream() {
  if (logStream) return
  const filter = encodeURIComponent('resource.type="gce_instance"')
  logStream = new EventSource(`/api/logs/stream?env=production&n=150&filter=${filter}`)
  logStream.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.error) addDeviceLog('all', 'WRN', `[logs] Cloud Logging read failed: ${data.error}`)
      else if (data.lines) appendCloudLines(data.lines)
    } catch {}
  }
  // EventSource reconnects on its own — no client-side retry loop.
}

function closeLogStream() {
  if (logStream) { logStream.close(); logStream = null }
}

// The starter/stopper processes ship their stdout into logd (component `script`,
// tag devbox-<box>); this streams it back out — logd is the log utility, use it.
let scriptStream = null
// Reopening the view re-backfills the same logd lines; identity = timestamp+tag+msg.
const seenScriptLines = new Set()

function addScriptLine(l) {
  const tag = String(l.tag || '')
  if (!tag.startsWith('devbox-')) return
  const key = `${l.ts}|${tag}|${l.msg}`
  if (seenScriptLines.has(key)) return
  seenScriptLines.add(key)
  const lvl = /err|fatal|50|60/.test(String(l.level)) ? 'ERR' : /warn|40/.test(String(l.level)) ? 'WRN' : 'INF'
  addDeviceLog(tag.slice(7), lvl, l.msg, l.ts)
}

async function openScriptStream() {
  if (scriptStream) return
  try {
    const res = await fetch('http://localhost:4319/logs/script?n=200')
    const { lines = [] } = await res.json()
    lines.forEach(addScriptLine)
  } catch { /* logd down — the stream below still retries on its own */ }
  scriptStream = new EventSource('http://localhost:4319/stream/script')
  scriptStream.onmessage = (e) => { try { addScriptLine(JSON.parse(e.data)) } catch {} }
}

function closeScriptStream() {
  if (scriptStream) { scriptStream.close(); scriptStream = null }
}

function addDeviceLog(device, level, msg, sourceTimestamp = Date.now()) {
  const timestamp = normalizeLogTimestamp(sourceTimestamp)
  const time = new Date(timestamp).toLocaleTimeString('en-US', { hour12: false })
  // Avoid duplicate adjacent log entries
  const last = deviceLogs.value[deviceLogs.value.length - 1]
  if (last && last.device === device && last.msg === msg) return
  deviceLogs.value.push({ time, timestamp: timestamp, sequence: logArrivalSequence++, device, level, msg })
  if (deviceLogs.value.length > 250) {
    deviceLogs.value.shift()
  }
}

const lastProgressMsg = ref({})
let inFlightFetch = false
let queued = false

// Live startup progress, pushed over SSE whenever the starter writes its state file.
// Every open page gets the same events: zone rotation, stockouts, phase changes.
let progressStream = null

// A start whose writer dies emits no further events, so nothing would ever clear its
// STARTING row. Arm one timeout for the moment the freshest entry crosses the 3-min
// staleness line; a newer event re-arms it.
let staleTimer = null
function armStaleTimer(entries) {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  const exp = entries.map(p => (p.timestamp || 0) + (p.phase === 'pulling' ? 35 * 60000 : 180000)).filter(Boolean)
  if (!exp.length) return
  const wait = Math.max(0, Math.max(...exp) - Date.now()) + 2000
  staleTimer = setTimeout(() => { staleTimer = null; fetchFleet() }, wait)
}

function applyProgress(state) {
  const applied = []
  for (const box of boxes.value) {
    const key = box.name.replace(/^yc-ollama-/, '')
    const p = state[key] || state[box.name]
    const terminal = p && (p.phase === 'ready' || p.phase === 'failed')
    if (terminal) {
      if (lastProgressMsg.value[box.name] !== p.msg) {
        lastProgressMsg.value[box.name] = p.msg
        addDeviceLog(box.name, p.phase === 'failed' ? 'ERR' : 'INF', `[watchdog] ${p.msg}`)
      }
      if (box.startupProgress) { box.startupProgress = null }
      fetchFleet()
      continue
    }
    // 'pulling' is one blocking multi-minute exec with no writes — its TTL matches the pull.
    const ttl = p?.phase === 'pulling' ? 35 * 60000 : 180000
    const fresh = p && !p.cancelled && Date.now() - (p.timestamp || 0) <= ttl
    if (fresh) {
      if (box.status === 'STOPPED') box.status = 'STARTING'
      box.startupProgress = p
      applied.push(p)
      if (p.msg && lastProgressMsg.value[box.name] !== p.msg) {
        lastProgressMsg.value[box.name] = p.msg
        addDeviceLog(box.name, p.msg.includes('stockout') ? 'WRN' : 'INF', `[watchdog] ${p.msg}`)
      }
    } else if (box.startupProgress) {
      // Entry vanished, cancelled, or went stale: the start ended — re-fetch real state.
      box.startupProgress = null
      fetchFleet()
    }
  }
  armStaleTimer(applied)
}

function openProgressStream() {
  if (progressStream) return
  progressStream = new EventSource('/api/devbox/stream')
  progressStream.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.progress) applyProgress(data.progress)
      if (data.fleet) fetchFleet()   // fleet snapshot changed on disk — pull the new truth once
    } catch {}
  }
}

function closeProgressStream() {
  if (progressStream) { progressStream.close(); progressStream = null }
}

// A stale response means the server just kicked a background snapshot refresh; chase it
// once so the corrected state actually reaches the page (no polling — one bounded follow-up).
let staleChase = null

async function fetchFleet() {
  if (inFlightFetch) {
    queued = true
    return
  }
  inFlightFetch = true
  loading.value = true
  try {
    const res = await $fetch('/api/devbox')
    if (res?.stale && !staleChase) {
      staleChase = setTimeout(() => { staleChase = null; fetchFleet() }, 6000)
    }
    if (res && res.ok) {
      if (res.workers) workers.value = res.workers
      if (res.boxes && res.boxes.length > 0) {
        const previousByName = new Map(boxes.value.map(b => [b.name, b]))
        boxes.value = res.boxes.map(b => {
          const progress = previousByName.get(b.name)?.startupProgress
          const ttl = progress?.phase === 'pulling' ? 35 * 60000 : 180000
          const fresh = progress && !progress.cancelled && Date.now() - (progress.timestamp || 0) <= ttl
          return {
            ...b,
            status: fresh && b.status === 'STOPPED' ? 'STARTING' : b.status,
            startupProgress: fresh ? progress : null,
            gpuPercent: b.gpuPercent ?? null,
            todayCost: b.todayCost ?? 0,
            todayCostFormatted: b.todayCostFormatted || ('$' + (b.todayCost ?? 0).toFixed(2))
          }
        })
        // Release the optimistic local 'starting' flag once server state has taken over, or after
        // 3 min (the same window readStartupState treats as stale) so a dead search can't stick.
        res.boxes.forEach(b => {
          if (actionState.value[b.name] !== 'starting') return
          const held = Date.now() - (startedAt.value[b.name] || 0)
          if (b.status === 'STARTING' || b.status === 'RUNNING' || held > 180000) {
            actionState.value[b.name] = null
            delete startedAt.value[b.name]
          }
        })
        // Same for 'stopping': hold it until GCP reports the box actually gone.
        res.boxes.forEach(b => {
          if (actionState.value[b.name] === 'stopping' && b.status === 'STOPPED') {
            actionState.value[b.name] = null
          }
        })
      }
      auth.value = res.auth || { ok: true }
      if (auth.value && auth.value.ok === false) {
        addDeviceLog('all', 'ERR', `[auth] ${auth.value.error || 'GCP credentials unavailable.'}`)
      }
    } else if (res && !res.ok) {
      auth.value = { ok: false, error: res.error }
      addDeviceLog('all', 'ERR', `[auth] ${res.error || 'GCP credentials unavailable.'}`)
    }
  } catch (e) {
    console.error('Fleet fetch failed:', e)
  } finally {
    loading.value = false
    inFlightFetch = false
    if (queued) {
      queued = false
      fetchFleet()
    }
  }
}

async function startBox(name) {
  actionState.value[name] = 'starting'
  if (auth.value && auth.value.ok === false) {
    actionState.value[name] = null
    addDeviceLog(name, 'ERR', `[auth] Cannot start ${name}: ${auth.value.error || 'GCP credentials unavailable.'}`)
    return
  }
  try {
    // Never 0 — that is the "Off" the dropdown no longer offers, and it ships a box with no watchdog.
    const timeoutMinutes = autoShutdown.value[name] || 5
    const model = selectedModel.value[name] ?? defaultModel.value
    addDeviceLog(name, 'INF', `[gcloud] Dispatched capacity search request for ${name} (${model}) to GCP backend…`)
    const res = await $fetch('/api/devbox', {
      method: 'POST',
      body: { action: 'start', box: name, timeoutMinutes, model }
    })
    if (res && res.ok === false) {
      if (res.authRequired || res.error?.includes('authenticated')) {
        auth.value = { ok: false, error: res.error || 'GCP credentials unavailable.' }
        addDeviceLog(name, 'ERR', `[auth] ${res.error || 'GCP credentials unavailable.'}`)
      }
    }
    // The POST returns in ms (the search runs detached), while the snapshot behind fetchFleet is up
    // to STALE_MS old and still predates the box. Clearing here would flash the row back to STOPPED,
    // so the local flag is held until the server reports STARTING/RUNNING (see fetchFleet).
    startedAt.value[name] = Date.now()
    await fetchFleet()
  } catch (e) {
    console.error(`Failed to start ${name}:`, e)
    addDeviceLog(name, 'ERR', `[error] Failed to start ${name}: ${e.message || e}`)
    actionState.value[name] = null
  }
}





async function stopBox(name) {
  actionState.value[name] = 'stopping'
  try {
    addDeviceLog(name, 'INF', `[gcloud] Dispatched stop command for ${name}…`)
    await $fetch('/api/devbox', {
      method: 'POST',
      body: { action: 'stop', box: name }
    })
    await fetchFleet()
  } catch (e) {
    console.error(`Failed to stop ${name}:`, e)
    addDeviceLog(name, 'ERR', `[error] Failed to stop ${name}: ${e.message || e}`)
    actionState.value[name] = null
  }
  // Leave 'stopping' set — the delete runs detached now, so fetchFleet clears it when GCP catches up.
}

async function stopAll() {
  stoppingAll.value = true
  try {
    const running = boxes.value.filter(b => b.status === 'RUNNING' || b.status === 'STARTING')
    for (const b of running) {
      await $fetch('/api/devbox', {
        method: 'POST',
        body: { action: 'stop', box: b.name }
      })
    }
    await fetchFleet()
  } catch (e) {
    console.error('Stop all failed:', e)
  } finally {
    stoppingAll.value = false
  }
}

function clearDeviceLogs() {
  deviceLogs.value = []
  cloudLogs.value = []
}

// No polling anywhere on this page: fleet loads on mount and on the Refresh button;
// logs stream over SSE only while the Logs tab is open.
watch(activeView, (v) => {
  if (v === 'logs') { openLogStream(); openScriptStream() }
  else { closeLogStream(); closeScriptStream() }
})

onMounted(() => {
  updateScreenSize()
  window.addEventListener('resize', updateScreenSize)

  fetchFleet()
  openProgressStream()
})


onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', updateScreenSize)
  }
  closeLogStream()
  closeScriptStream()
  closeProgressStream()
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  if (staleChase) { clearTimeout(staleChase); staleChase = null }
})
</script>
