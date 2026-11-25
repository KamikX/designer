<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import type { ExternalLibraryRef, InstalledLibrary, Stack } from '@shared/types'

const props = defineProps<{ stack: Stack; disabled?: boolean }>()
const model = defineModel<ExternalLibraryRef[]>({ default: () => [] })
const libraries = ref<InstalledLibrary[]>([])
const error = ref('')
const loading = ref(true)
const available = computed(() =>
  libraries.value.filter((l) => props.stack !== 'html' && l.stacks.includes(props.stack))
)
const missing = computed(() =>
  model.value.filter(
    (ref) => !available.value.some((l) => l.name === ref.name && l.version === ref.version)
  )
)
onMounted(async () => {
  try {
    libraries.value = await window.api.libraries.list()
  } catch (e) {
    error.value = uiMessage(String(e))
  } finally {
    loading.value = false
  }
})
function selected(lib: ExternalLibraryRef): boolean {
  return model.value.some((ref) => ref.name === lib.name && ref.version === lib.version)
}
function toggle(lib: ExternalLibraryRef): void {
  const wasSelected = selected(lib)
  const next = model.value
    .filter((ref) => ref.name !== lib.name)
    .map((ref) => ({ name: ref.name, version: ref.version }))
  model.value = wasSelected ? next : [...next, { name: lib.name, version: lib.version }]
}
</script>

<template>
  <div class="library-picker">
    <a-spin v-if="loading" size="small" />
    <a-alert v-if="error" type="error" :message="error" />
    <p v-if="!loading && !available.length">
      {{ t('messages.installNpmPackagesInSettingsLibrariesFirst') }}
    </p>
    <label v-for="lib in available" :key="lib.id" class="library-option">
      <a-checkbox
        :checked="selected(lib)"
        :disabled="disabled || (!lib.ready && !selected(lib))"
        @change="toggle(lib)"
      />
      <span
        ><strong>{{ lib.name }}</strong> @{{ lib.version }}<br /><small>{{
          lib.ready ? lib.description : t('messages.filesMissingReinstallThisVersion')
        }}</small></span
      >
    </label>
    <label v-for="lib in missing" :key="lib.name + lib.version" class="library-option">
      <a-checkbox checked :disabled="disabled" @change="toggle(lib)" />
      <span
        >{{ lib.name }}@{{ lib.version }} —
        {{ t('messages.notInstalledOrIncompatibleDeselectToRemove') }}</span
      >
    </label>
  </div>
</template>

<style scoped>
.library-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 280px;
  overflow-y: auto;
}
.library-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.library-option small {
  opacity: 0.7;
}
</style>
