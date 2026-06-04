<template>
  <div class="glass p-6">
    <div class="text-xs text-gray-400 uppercase tracking-wide mb-3">Quick Links</div>
    <div class="flex flex-wrap gap-2">
      <!-- MongoDB -->
      <a
        href="mongodb://localhost:27017"
        target="_blank"
        class="glass px-3 py-1 rounded text-sm hover:text-amber-500 transition"
        title="MongoDB Compass"
      >
        MongoDB
      </a>

      <!-- Neo4j -->
      <a
        href="https://browser.neo4j.io"
        target="_blank"
        class="glass px-3 py-1 rounded text-sm hover:text-amber-500 transition"
        title="Neo4j Browser"
      >
        Neo4j
      </a>

      <!-- Firebase -->
      <a
        href="https://console.firebase.google.com/project/yeschef-c572a"
        target="_blank"
        class="glass px-3 py-1 rounded text-sm hover:text-amber-500 transition"
        title="Firebase Console"
      >
        Firebase
      </a>

      <!-- Local Only -->
      <a
        v-if="environment === 'local'"
        href="http://localhost:4000"
        target="_blank"
        class="glass px-3 py-1 rounded text-sm hover:text-amber-500 transition"
        title="Firebase Emulator"
      >
        Emulator
      </a>

      <a
        v-if="environment === 'local'"
        href="http://localhost:11434"
        target="_blank"
        class="glass px-3 py-1 rounded text-sm hover:text-amber-500 transition"
        title="Ollama Server"
      >
        Ollama
      </a>

      <!-- Production Only -->
      <a
        v-if="environment === 'production'"
        href="https://console.cloud.google.com/run?project=yeschef-c572a"
        target="_blank"
        class="glass px-3 py-1 rounded text-sm hover:text-amber-500 transition"
        title="Cloud Run"
      >
        Cloud Run
      </a>
    </div>
  </div>
</template>

<script setup>
defineProps({
  environment: String,
});
</script>
