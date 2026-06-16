<template>
  <button
    type="button"
    @click="$emit('update:modelValue', !modelValue)"
    :class="[
      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
      modelValue
        ? 'bg-emerald-600 hover:bg-emerald-700'
        : 'bg-gray-700 hover:bg-gray-600'
    ]"
    :title="modelValue ? 'Active' : 'Inactive'"
  >
    <span
      :class="[
        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
        modelValue ? 'translate-x-6' : 'translate-x-1'
      ]"
    />
  </button>
</template>

<script setup>
defineProps({
  modelValue: {
    type: Boolean,
    required: true
  }
})

defineEmits(['update:modelValue'])
</script>
