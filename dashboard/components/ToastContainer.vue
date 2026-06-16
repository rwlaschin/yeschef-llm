<template>
  <Teleport to="body">
    <div class="fixed bottom-4 left-4 space-y-3 z-50 pointer-events-none">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          :class="[
            'glass p-4 rounded-lg pointer-events-auto flex items-start gap-3 min-w-96 max-w-96 border',
            toastColor(toast.type),
          ]"
        >
          <span class="text-xl flex-shrink-0">{{ toastIcon(toast.type) }}</span>
          <div class="flex-1 min-w-0">
            <p class="font-semibold">{{ toast.title }}</p>
            <p v-if="toast.message" class="text-sm opacity-80 mt-1">
              {{ toast.message }}
            </p>
          </div>
          <button
            @click="removeToast(toast.id)"
            class="flex-shrink-0 ml-2 hover:opacity-70 transition"
          >
            ✕
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup>
const { toasts, removeToast } = useToast();

const toastIcon = (type) => {
  const icons = {
    success: "✓",
    error: "✕",
    info: "ℹ",
    warning: "⚠",
  };
  return icons[type] || "•";
};

const toastColor = (type) => {
  return {
    success: "bg-green-500/20 border-green-500/30",
    error: "bg-red-500/20 border-red-500/30",
    info: "bg-blue-500/20 border-blue-500/30",
    warning: "bg-yellow-500/20 border-yellow-500/30",
  }[type];
};
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 300ms ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(-100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(-100%);
}
</style>
