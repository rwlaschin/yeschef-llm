<template>
  <div class="glass h-full flex flex-col p-6">
    <!-- Controls -->
    <div class="flex gap-2 mb-4">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search logs..."
        class="flex-1 glass px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
      />
      <button
        @click="clearLogs"
        class="text-xs glass px-4 py-2 rounded-lg hover:bg-opacity-50 transition focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        Clear
      </button>
    </div>

    <!-- Logs List -->
    <div class="flex-1 overflow-y-auto space-y-2 font-mono text-xs">
      <div v-if="filteredLogs.length === 0" class="text-center py-8 opacity-50">
        {{ logs.length === 0 ? "No logs yet" : "No matching logs" }}
      </div>

      <div
        v-for="(log, idx) in filteredLogs"
        :key="idx"
        :class="[
          'p-2 rounded glass transition hover:bg-opacity-60',
          getLevelColor(log.level),
        ]"
      >
        <div class="flex items-start justify-between mb-1">
          <span class="text-amber-400">{{ formatTime(log.timestamp) }}</span>
          <span :class="['px-2 py-0.5 rounded text-xs font-medium', getLevelBg(log.level)]">
            {{ getLevelName(log.level) }}
          </span>
        </div>
        <p>{{ log.msg }}</p>
        <p v-if="log.module" class="opacity-60 text-xs mt-1">{{ log.module }}</p>
      </div>
    </div>

    <!-- Log Count -->
    <div class="mt-4 pt-4 border-t border-gray-700/30 dark:border-gray-700/30 text-xs opacity-60">
      <p>Showing {{ filteredLogs.length }} of {{ logs.length }} logs</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const { logs, clearLogs: clearLogsOrig } = useLogs();
const { success } = useToast();
const searchQuery = ref("");

const clearLogs = () => {
  clearLogsOrig();
  success("Cleared", "All logs removed");
};

const filteredLogs = computed(() => {
  if (!searchQuery.value.trim()) return logs.value;
  const query = searchQuery.value.toLowerCase();
  return logs.value.filter(
    (log) =>
      log.msg?.toLowerCase().includes(query) ||
      log.module?.toLowerCase().includes(query)
  );
});

const getLevelName = (level) => {
  const levels = { 10: "TRC", 20: "DBG", 30: "INF", 40: "WRN", 50: "ERR", 60: "FAT" };
  return levels[level] || "INF";
};

const getLevelColor = (level) => {
  if (level === 50) return "bg-red-500/10";
  if (level === 40) return "bg-yellow-500/10";
  return "bg-blue-500/10";
};

const getLevelBg = (level) => {
  if (level === 50) return "bg-red-500/20 text-red-300";
  if (level === 40) return "bg-yellow-500/20 text-yellow-300";
  return "bg-blue-500/20 text-blue-300";
};

const formatTime = (timestamp) => {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return timestamp;
  }
};
</script>
