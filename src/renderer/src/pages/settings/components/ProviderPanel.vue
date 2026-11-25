<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { DownOutlined, PlusOutlined, SyncOutlined } from '@antdv-next/icons'
import { useProviderStore } from '@renderer/stores/provider'
import { inferModelMeta } from '@shared/model-caps'
import type {
  AdapterType,
  Model,
  ModelAbility,
  ModelSelection,
  ModelType,
  Provider,
  RemoteModel
} from '@shared/types'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message, modal } = App.useApp()

/**
 * AI 供应商配置(合并了模型管理)。
 *
 * 列表默认为空——内置的几家只是"添加向导"里的预设模板,选中即预填
 * 端点与推荐模型,保存后才成为列表里的卡片。
 *
 * 模型元数据分两维:类型(对话/绘图/向量/重排/语音,单选,决定用在
 * 哪个功能里)与能力(仅对话类:识图/文件/工具,多选)。二者都按
 * 模型名推断默认值,抽屉里可逐个纠正。密钥永远只写不读。
 */

const { token } = theme.useToken()
const store = useProviderStore()

const ADAPTER_LABEL: Record<string, string> = {
  get openai() {
    return t('common.openaiApi')
  },
  get anthropic() {
    return t('common.anthropicApi')
  },
  get google() {
    return t('common.geminiApi')
  },
  get deepseek() {
    return t('common.deepseekApi')
  },
  get 'openai-compatible'() {
    return t('common.openaiCompatibleApi')
  }
}

const TYPE_OPTIONS: { label: string; value: ModelType }[] = [
  {
    get label() {
      return t('common.chatLabel')
    },
    value: 'chat'
  },
  {
    get label() {
      return t('common.imageGeneration')
    },
    value: 'image'
  },
  {
    get label() {
      return t('common.embeddings')
    },
    value: 'embedding'
  },
  {
    get label() {
      return t('common.reranking')
    },
    value: 'rerank'
  },
  {
    get label() {
      return t('common.textToSpeech')
    },
    value: 'tts'
  },
  {
    get label() {
      return t('common.speechRecognition')
    },
    value: 'stt'
  }
]

const TYPE_LABEL = computed<Record<string, string>>(() =>
  Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]))
)

const ABILITY_OPTIONS: { label: string; value: ModelAbility }[] = [
  {
    get label() {
      return t('common.imageInput')
    },
    value: 'vision'
  },
  {
    get label() {
      return t('common.file')
    },
    value: 'files'
  },
  {
    get label() {
      return t('common.tools')
    },
    value: 'tools'
  }
]

const ABILITY_LABEL = computed<Record<string, string>>(() =>
  Object.fromEntries(ABILITY_OPTIONS.map((o) => [o.value, o.label]))
)

interface PresetModel {
  modelId: string
  displayName: string
  type: ModelType
  abilities: ModelAbility[]
  contextWindow: number
}

interface Preset {
  key: string
  label: string
  adapter: AdapterType
  baseUrl: string
  models: PresetModel[]
}

/** 添加向导里的预设模板。推荐模型只是初始勾选,可增删可改 */
const PRESETS: Preset[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    adapter: 'openai',
    baseUrl: '',
    models: [
      {
        modelId: 'gpt-5.1',
        displayName: 'GPT-5.1',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 400000
      },
      {
        modelId: 'gpt-5',
        displayName: 'GPT-5',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 400000
      },
      {
        modelId: 'gpt-5-mini',
        displayName: 'GPT-5 mini',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 400000
      },
      {
        modelId: 'gpt-image-1',
        displayName: 'GPT Image 1',
        type: 'image',
        abilities: [],
        contextWindow: 32000
      },
      {
        modelId: 'text-embedding-3-large',
        displayName: 'Text Embedding 3 Large',
        type: 'embedding',
        abilities: [],
        contextWindow: 8192
      }
    ]
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    adapter: 'anthropic',
    baseUrl: '',
    models: [
      {
        modelId: 'claude-opus-4-5',
        displayName: 'Claude Opus 4.5',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 200000
      },
      {
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 200000
      },
      {
        modelId: 'claude-haiku-4-5',
        displayName: 'Claude Haiku 4.5',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 200000
      }
    ]
  },
  {
    key: 'google',
    label: 'Google Gemini',
    adapter: 'google',
    baseUrl: '',
    models: [
      {
        modelId: 'gemini-3-pro-preview',
        displayName: 'Gemini 3 Pro',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 1000000
      },
      {
        modelId: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 1000000
      },
      {
        modelId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        type: 'chat',
        abilities: ['vision', 'files', 'tools'],
        contextWindow: 1000000
      }
    ]
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    adapter: 'deepseek',
    baseUrl: '',
    models: [
      {
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        type: 'chat',
        abilities: ['tools'],
        contextWindow: 128000
      },
      {
        modelId: 'deepseek-reasoner',
        displayName: 'DeepSeek Reasoner',
        type: 'chat',
        abilities: ['tools'],
        contextWindow: 128000
      }
    ]
  },
  {
    key: 'zhipu',
    get label() {
      return t('common.zhipuAi')
    },
    adapter: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      {
        modelId: 'glm-4.6',
        displayName: 'GLM-4.6',
        type: 'chat',
        abilities: ['tools'],
        contextWindow: 200000
      },
      {
        modelId: 'glm-4.5v',
        displayName: 'GLM-4.5V',
        type: 'chat',
        abilities: ['vision', 'tools'],
        contextWindow: 64000
      },
      {
        modelId: 'glm-4.5-air',
        displayName: 'GLM-4.5 Air',
        type: 'chat',
        abilities: ['tools'],
        contextWindow: 128000
      },
      {
        modelId: 'cogview-4',
        displayName: 'CogView-4',
        type: 'image',
        abilities: [],
        contextWindow: 4000
      }
    ]
  },
  {
    key: 'custom',
    get label() {
      return t('common.otherOpenaiCompatible')
    },
    adapter: 'openai-compatible',
    baseUrl: '',
    models: []
  }
]

/* ---------------- 配置抽屉(添加 / 编辑共用) ---------------- */

const drawer = reactive({
  open: false,
  /** null = 添加模式 */
  editing: null as Provider | null,
  presetKey: 'openai',
  name: '',
  baseUrl: '',
  apiKey: '',
  /** 下拉候选:预设推荐 ∪ 远程拉取 ∪ 已有 */
  candidates: [] as RemoteModel[],
  /** 选中的模型 ID(tags 模式可手输) */
  checked: [] as string[],
  /** 每个选中模型的类型与能力(默认推断,可改) */
  types: {} as Record<string, ModelType>,
  abilities: {} as Record<string, ModelAbility[]>,
  /** 展示名/上下文等元数据,来自预设或已有行,保存时透传 */
  meta: {} as Record<string, { displayName?: string; contextWindow?: number }>,
  loadingModels: false,
  saving: false
})

const isEdit = computed(() => drawer.editing != null)
const activePreset = computed(() => PRESETS.find((p) => p.key === drawer.presetKey)!)
const currentAdapter = computed<AdapterType>(() =>
  drawer.editing ? drawer.editing.adapter : activePreset.value.adapter
)

function applyPreset(preset: Preset): void {
  drawer.name = preset.label
  drawer.baseUrl = preset.baseUrl
  // 推荐模型只进下拉候选,不默认选中——没填内容前列表保持干净,
  // 选中某个候选时类型/能力从这里的映射取到正确默认值
  drawer.candidates = preset.models.map((m) => ({ modelId: m.modelId, displayName: m.displayName }))
  drawer.checked = []
  drawer.types = Object.fromEntries(preset.models.map((m) => [m.modelId, m.type]))
  drawer.abilities = Object.fromEntries(preset.models.map((m) => [m.modelId, [...m.abilities]]))
  drawer.meta = Object.fromEntries(
    preset.models.map((m) => [
      m.modelId,
      { displayName: m.displayName, contextWindow: m.contextWindow }
    ])
  )
}

function openAdd(): void {
  Object.assign(drawer, {
    open: true,
    editing: null,
    presetKey: PRESETS[0].key,
    apiKey: ''
  })
  applyPreset(PRESETS[0])
}

function openEdit(p: Provider): void {
  const existing = store.models.filter((m) => m.providerId === p.id)
  Object.assign(drawer, {
    open: true,
    editing: p,
    presetKey: 'custom',
    name: p.name,
    baseUrl: p.baseUrl ?? '',
    apiKey: '',
    candidates: existing.map((m) => ({ modelId: m.modelId, displayName: m.displayName })),
    checked: existing.filter((m) => m.enabled).map((m) => m.modelId),
    types: Object.fromEntries(existing.map((m) => [m.modelId, m.type])),
    abilities: Object.fromEntries(existing.map((m) => [m.modelId, [...m.abilities]])),
    meta: Object.fromEntries(
      existing.map((m) => [
        m.modelId,
        { displayName: m.displayName, contextWindow: m.contextWindow }
      ])
    )
  })
}

// 添加模式下切换类型 → 整体应用该预设
watch(
  () => drawer.presetKey,
  () => {
    if (!isEdit.value) applyPreset(activePreset.value)
  }
)

// 手输/新勾选的模型即时补推断默认值,编辑区不出现空行
watch(
  () => [...drawer.checked],
  (ids) => {
    for (const id of ids) {
      if (!drawer.types[id]) {
        const inferred = inferModelMeta(id)
        drawer.types[id] = inferred.type
        drawer.abilities[id] = inferred.abilities
      }
    }
  }
)

async function loadModels(): Promise<void> {
  if (!drawer.apiKey.trim() && !drawer.editing?.hasKey) {
    message.warning(t('messages.enterAnApiKeyFirst'))
    return
  }
  drawer.loadingModels = true
  try {
    const remote = await store.fetchModels({
      adapter: currentAdapter.value,
      providerId: drawer.editing?.id,
      baseUrl: drawer.baseUrl.trim() || null,
      apiKey: drawer.apiKey.trim() || undefined
    })
    // 远程清单为主,已勾选但远程没有的(预设推荐/手输)保留在候选里
    const seen = new Set(remote.map((m) => m.modelId))
    const kept = drawer.candidates.filter(
      (m) => !seen.has(m.modelId) && drawer.checked.includes(m.modelId)
    )
    drawer.candidates = [...remote, ...kept]
    message.success(t('common.fetchedModels', remote.length))
  } catch (err) {
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  } finally {
    drawer.loadingModels = false
  }
}

function buildSelections(): ModelSelection[] {
  // 全部展开成普通对象/数组:reactive 代理过不了 IPC 的 structured clone,
  // 直接传会抛 "object could not be cloned"
  return drawer.checked.map((modelId) => ({
    modelId,
    displayName:
      drawer.meta[modelId]?.displayName ??
      drawer.candidates.find((c) => c.modelId === modelId)?.displayName,
    type: drawer.types[modelId],
    abilities: drawer.types[modelId] === 'chat' ? [...(drawer.abilities[modelId] ?? [])] : [],
    contextWindow: drawer.meta[modelId]?.contextWindow
  }))
}

async function save(): Promise<void> {
  if (!drawer.name.trim()) {
    message.warning(t('messages.enterAProviderName'))
    return
  }
  drawer.saving = true
  try {
    if (drawer.editing) {
      await store.updateProvider(drawer.editing.id, {
        name: drawer.name.trim(),
        baseUrl: drawer.baseUrl.trim() || null
      })
      if (drawer.apiKey.trim()) await store.setKey(drawer.editing.id, drawer.apiKey.trim())
      await store.setModelSelection(drawer.editing.id, buildSelections())
    } else {
      const provider = await store.createProvider({
        name: drawer.name.trim(),
        adapter: currentAdapter.value,
        baseUrl: drawer.baseUrl.trim() || undefined,
        apiKey: drawer.apiKey.trim() || undefined
      })
      await store.setModelSelection(provider.id, buildSelections())
    }
    drawer.open = false
    message.success(t('common.saved'))
  } catch (err) {
    // 任何一步失败都要让用户看见,不能静默吞掉
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  } finally {
    drawer.saving = false
  }
}

/* ---------------- 卡片列表操作 ---------------- */

const testing = reactive<Record<string, boolean>>({})
const testResult = reactive<Record<string, string>>({})

async function runTest(p: Provider): Promise<void> {
  testing[p.id] = true
  testResult[p.id] = ''
  try {
    const r = await store.test(p.id)
    testResult[p.id] = r.ok ? t('common.connectedMs', r.latencyMs) : `✗ ${uiMessage(r.error)}`
  } finally {
    testing[p.id] = false
  }
}

function confirmRemove(p: Provider): void {
  modal.confirm({
    get title() {
      return t('common.deleteProvider', p.name)
    },
    content: t('messages.itsModelConfigurationsWillAlsoBeDeleted'),
    okType: 'danger',
    onOk: () => store.removeProvider(p.id)
  })
}

/* ---------------- 卡片展开/收起 ---------------- */

const expanded = ref(new Set<string>())

function toggleExpand(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 模型行右侧的说明:对话类显示能力,其余显示类型 */
function modelMeta(m: Model): string {
  if (m.type !== 'chat') return TYPE_LABEL.value[m.type] ?? m.type
  const abilities = m.abilities.map((a) => ABILITY_LABEL.value[a] ?? a).join(' / ')
  return abilities ? t('common.chatLabelText', abilities) : t('common.chatLabel')
}
</script>

<template>
  <div style="max-width: 800px">
    <a-flex justify="space-between" align="center" style="margin-bottom: 12px">
      <span style="font-size: 12px; opacity: 0.65">
        {{ t('messages.keysAreEncryptedLocallyAndNever') }}
      </span>
      <a-button type="primary" @click="openAdd">
        <template #icon><PlusOutlined /></template>
        {{ t('common.addProvider') }}
      </a-button>
    </a-flex>

    <a-empty
      v-if="store.loaded && store.providers.length === 0"
      :description="t('common.noProvidersConfigured')"
      style="margin-top: 80px"
    >
      <a-button type="primary" @click="openAdd">{{ t('common.addProvider') }}</a-button>
    </a-empty>

    <div v-else class="provider-cards">
      <div
        v-for="p in store.providers"
        :key="p.id"
        class="provider-card"
        :style="{ borderColor: token.colorBorderSecondary }"
      >
        <!-- 头部一行:点击展开/收起;操作区固定在右侧不被挤压 -->
        <a-flex
          justify="space-between"
          align="center"
          :gap="12"
          class="provider-card-header"
          @click="toggleExpand(p.id)"
        >
          <a-flex align="center" :gap="8" style="min-width: 0">
            <DownOutlined
              class="provider-expand-icon"
              :class="{ 'provider-expand-icon--open': expanded.has(p.id) }"
            />
            <span style="font-weight: 600; white-space: nowrap">{{ p.name }}</span>
            <a-tag style="margin: 0; flex-shrink: 0">
              {{ ADAPTER_LABEL[p.adapter] ?? p.adapter }}
            </a-tag>
            <a-tag v-if="p.hasKey && p.keyStorage === 'plain'" color="warning" style="margin: 0">
              {{ t('common.plaintextKey') }}
            </a-tag>
            <span class="provider-card-hint">
              {{ p.hasKey ? t('common.key', p.keyHint) : t('common.noKeyConfigured') }}
              · {{ store.enabledModelsOf(p.id).length }} {{ t('common.models') }}
              <template v-if="testResult[p.id]"> · {{ testResult[p.id] }}</template>
            </span>
          </a-flex>

          <a-space :size="12" class="provider-card-actions" @click.stop>
            <a-button type="link" size="small" style="padding: 0" @click="openEdit(p)">
              {{ t('common.configure') }}
            </a-button>
            <a-button
              type="link"
              size="small"
              style="padding: 0"
              :loading="testing[p.id]"
              :disabled="!p.hasKey"
              @click="runTest(p)"
            >
              {{ t('common.test') }}
            </a-button>
            <a style="color: var(--ant-color-error); font-size: 13px" @click="confirmRemove(p)">
              {{ t('common.deleteLabel') }}
            </a>
            <a-switch
              :checked="p.enabled"
              size="small"
              @change="(v: boolean) => store.updateProvider(p.id, { enabled: v })"
            />
          </a-space>
        </a-flex>

        <!-- 展开区:启用模型的列表(非 tag) -->
        <div
          v-if="expanded.has(p.id)"
          class="provider-model-list"
          :style="{ borderColor: token.colorBorderSecondary }"
        >
          <template v-if="store.enabledModelsOf(p.id).length">
            <a-flex
              v-for="m in store.enabledModelsOf(p.id)"
              :key="m.id"
              justify="space-between"
              align="center"
              class="provider-model-row"
            >
              <div style="min-width: 0">
                <span style="font-size: 13px">{{ m.displayName }}</span>
                <span v-if="m.displayName !== m.modelId" class="provider-model-id">
                  {{ m.modelId }}
                </span>
              </div>
              <span class="provider-model-meta">{{ modelMeta(m) }}</span>
            </a-flex>
          </template>
          <div v-else style="font-size: 12px; opacity: 0.45; padding: 8px 0">
            {{ t('messages.noModelsEnabledClickConfigureToAddOne') }}
          </div>
        </div>
      </div>
    </div>

    <a-drawer
      v-model:open="drawer.open"
      :title="isEdit ? t('common.configureLabel', drawer.editing?.name) : t('common.addProvider')"
      size="large"
      destroy-on-close
    >
      <a-form layout="vertical">
        <a-form-item v-if="!isEdit" :label="t('common.selectProvider')">
          <a-select
            v-model:value="drawer.presetKey"
            :options="PRESETS.map((p) => ({ label: p.label, value: p.key }))"
          />
        </a-form-item>

        <a-form-item :label="t('common.name')" required>
          <a-input v-model:value="drawer.name" :placeholder="t('messages.eGOpenaiCustomProxy')" />
        </a-form-item>

        <a-form-item label="Base URL">
          <a-input
            v-model:value="drawer.baseUrl"
            :placeholder="t('messages.leaveBlankToUseTheOfficialDefaultEndpoint')"
          />
        </a-form-item>

        <a-form-item
          :label="drawer.editing?.hasKey ? t('messages.apiKeySavedLeaveBlankToKeep') : 'API Key'"
        >
          <a-input-password
            v-model:value="drawer.apiKey"
            autocomplete="off"
            :placeholder="t('messages.onlyAMaskedIndicatorIsShownAfterSaving')"
          />
        </a-form-item>

        <a-form-item :label="t('common.model')">
          <a-flex :gap="8">
            <a-select
              v-model:value="drawer.checked"
              mode="tags"
              style="flex: 1; min-width: 0"
              :placeholder="t('messages.presetsRecommendCommonModelsFetchSearchOrEnterAModelId')"
              :options="drawer.candidates.map((m) => ({ label: m.displayName, value: m.modelId }))"
              :max-tag-count="6"
              allow-clear
            />
            <a-button
              :loading="drawer.loadingModels"
              :disabled="!drawer.apiKey.trim() && !drawer.editing?.hasKey"
              @click="loadModels"
            >
              <template #icon><SyncOutlined /></template>
              {{ t('common.loadModels') }}
            </a-button>
          </a-flex>
        </a-form-item>

        <a-form-item v-if="drawer.checked.length" :label="t('messages.modelTypesAndCapabilities')">
          <div class="caps-hint">
            {{ t('messages.typeDeterminesWhereAModelIs') }}
          </div>
          <div class="caps-list" :style="{ borderColor: token.colorBorderSecondary }">
            <a-flex
              v-for="modelId in drawer.checked"
              :key="modelId"
              align="center"
              :gap="10"
              class="caps-row"
            >
              <span class="caps-model">{{ modelId }}</span>
              <a-select
                v-model:value="drawer.types[modelId]"
                :options="TYPE_OPTIONS"
                size="small"
                style="width: 104px; flex-shrink: 0"
              />
              <a-checkbox-group
                v-if="drawer.types[modelId] === 'chat'"
                v-model:value="drawer.abilities[modelId]"
                :options="ABILITY_OPTIONS"
              />
            </a-flex>
          </div>
        </a-form-item>
      </a-form>

      <template #footer>
        <a-flex justify="flex-end" :gap="8">
          <a-button @click="drawer.open = false">{{ t('common.cancel') }}</a-button>
          <a-button type="primary" :loading="drawer.saving" @click="save">{{
            t('common.save')
          }}</a-button>
        </a-flex>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.provider-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-card {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 10px 14px;
  transition: border-color 0.15s;
}

.provider-card:hover {
  border-color: var(--ant-color-primary) !important;
}

.provider-card-header {
  cursor: pointer;
}

.provider-expand-icon {
  font-size: 11px;
  opacity: 0.45;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.provider-expand-icon--open {
  transform: rotate(180deg);
}

.provider-card-hint {
  font-size: 12px;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card-actions {
  flex-shrink: 0;
}

.provider-model-list {
  margin-top: 10px;
  padding: 2px 0 2px 22px;
  border-top: 1px solid transparent;
}

.provider-model-row {
  padding: 6px 0;
}

.provider-model-id {
  margin-left: 8px;
  font-size: 12px;
  opacity: 0.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.provider-model-meta {
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.6;
  margin-left: 16px;
}

.caps-hint {
  font-size: 12px;
  opacity: 0.55;
  margin-bottom: 6px;
}

.caps-list {
  border: 1px solid transparent;
  border-radius: 6px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px 12px;
}

.caps-row {
  padding: 5px 0;
}

.caps-model {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
