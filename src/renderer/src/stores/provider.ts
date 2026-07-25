import { defineStore } from 'pinia'
import type {
  CreateProviderInput,
  FetchModelsInput,
  Model,
  ModelSelection,
  Provider,
  ProviderTestResult,
  RemoteModel
} from '@shared/types'

/**
 * 供应商 / 模型配置的全局状态。
 *
 * 设置页和工作台的模型选择器共用这一份数据,不用各自拉一遍;
 * 所有写操作都走"调 IPC → 用返回值原地更新",不整表重拉。
 */
export const useProviderStore = defineStore('provider', {
  state: () => ({
    providers: [] as Provider[],
    models: [] as Model[],
    loaded: false
  }),

  getters: {
    /** 工作台模型选择器的数据源:启用供应商下启用的对话模型 */
    chatModels(state): { provider: Provider; models: Model[] }[] {
      return state.providers
        .filter((p) => p.enabled && p.hasKey)
        .map((provider) => ({
          provider,
          models: state.models.filter(
            (m) => m.providerId === provider.id && m.enabled && m.type === 'chat'
          )
        }))
        .filter((group) => group.models.length > 0)
    },
    /** 某供应商已启用的模型(供应商卡片上的清单展示) */
    enabledModelsOf(state): (providerId: string) => Model[] {
      return (providerId) => state.models.filter((m) => m.providerId === providerId && m.enabled)
    }
  },

  actions: {
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return
      const [providers, models] = await Promise.all([
        window.api.provider.list(),
        window.api.model.list()
      ])
      this.providers = providers
      this.models = models
      this.loaded = true
    },

    replaceProvider(next: Provider): void {
      const i = this.providers.findIndex((p) => p.id === next.id)
      if (i >= 0) this.providers[i] = next
      else this.providers.push(next)
    },

    async setKey(id: string, apiKey: string): Promise<void> {
      this.replaceProvider(await window.api.provider.setKey(id, apiKey))
    },

    async updateProvider(
      id: string,
      patch: Partial<Pick<Provider, 'name' | 'baseUrl' | 'enabled'>>
    ): Promise<void> {
      const next = await window.api.provider.update(id, patch)
      if (next) this.replaceProvider(next)
    },

    async createProvider(input: CreateProviderInput): Promise<Provider> {
      const provider = await window.api.provider.create(input)
      this.providers.push(provider)
      return provider
    },

    async removeProvider(id: string): Promise<void> {
      await window.api.provider.remove(id)
      this.providers = this.providers.filter((p) => p.id !== id)
      this.models = this.models.filter((m) => m.providerId !== id)
    },

    test(id: string, modelId?: string): Promise<ProviderTestResult> {
      return window.api.provider.test(id, modelId)
    },

    fetchModels(input: FetchModelsInput): Promise<RemoteModel[]> {
      return window.api.provider.fetchModels(input)
    },

    /** 按勾选整定模型清单,并用返回值刷新该供应商的本地模型状态 */
    async setModelSelection(providerId: string, selections: ModelSelection[]): Promise<void> {
      const next = await window.api.model.setSelection(providerId, selections)
      this.models = [...this.models.filter((m) => m.providerId !== providerId), ...next]
    }
  }
})
