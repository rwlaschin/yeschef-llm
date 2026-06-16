<template>
  <Teleport to="body">
    <div v-if="isOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div class="glass p-6 rounded-lg max-w-sm w-full mx-4">
        <!-- Title -->
        <h2 class="text-lg font-serif text-primary mb-4">{{ title }}</h2>

        <!-- Message -->
        <p class="text-sm text-secondary mb-6">{{ message }}</p>

        <!-- Action Buttons -->
        <div class="flex gap-3 justify-end">
          <button
            @click="cancel"
            class="px-4 py-2 rounded btn-muted transition font-medium"
          >
            Cancel
          </button>
          <button
            @click="confirm"
            :class="[
              'px-4 py-2 rounded font-medium transition',
              isDangerous
                ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50 border border-red-900/50'
                : 'bg-amber-500 text-gray-900 hover:bg-amber-600'
            ]"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const isOpen = ref(false)
const title = ref('Confirm')
const message = ref('Are you sure?')
const confirmText = ref('Confirm')
const isDangerous = ref(false)
let resolvePromise = null

const open = (config) => {
  title.value = config.title || 'Confirm'
  message.value = config.message || 'Are you sure?'
  confirmText.value = config.confirmText || 'Confirm'
  isDangerous.value = config.isDangerous || false
  isOpen.value = true

  return new Promise((resolve) => {
    resolvePromise = resolve
  })
}

// Debug: log when component mounts
onMounted(() => {
  console.log('ConfirmDialog mounted')
})

const confirm = () => {
  isOpen.value = false
  if (resolvePromise) resolvePromise(true)
}

const cancel = () => {
  isOpen.value = false
  if (resolvePromise) resolvePromise(false)
}

defineExpose({ open })
</script>
