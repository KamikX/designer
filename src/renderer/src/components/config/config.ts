import type { ConfigProviderProps, ThemeConfig } from 'antdv-next'
import type { ComputedRef, WritableComputedRef } from 'vue'
import { theme } from 'antdv-next'
import enUS from 'antdv-next/locale/en_US'
import zhCN from 'antdv-next/locale/zh_CN'
import dayjs from 'dayjs'
import { useStorage } from '@vueuse/core'
import { computed, watch, watchEffect } from 'vue'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/en'

/* -------------------------------------------------------------------------
 * 全局配置中心
 * 语言、主题、ConfigProvider 的所有可调项都收在这个文件里，
 * 组件侧只消费 useAppConfig()，不要在别处零散地配。
 * ---------------------------------------------------------------------- */

export type Lang = 'zh-CN' | 'en-US'

interface LocaleEntry {
  /** antdv-next 语言包：组件自带文案（确定 / 取消 / 暂无数据…） */
  antd: ConfigProviderProps['locale']
  /** dayjs 语言标识：日期组件里的年月、星期 */
  dayjs: string
  /** 语言切换控件上显示的名字 */
  label: string
}

/** 支持的语言。加语种只需在这里加一项 */
export const LOCALES: Record<Lang, LocaleEntry> = {
  'zh-CN': { antd: zhCN, dayjs: 'zh-cn', label: '简体中文' },
  'en-US': { antd: enUS, dayjs: 'en', label: 'English' }
}

/** 语言切换控件可以直接用的 options */
export const LANG_OPTIONS = (Object.keys(LOCALES) as Lang[]).map((value) => ({
  value,
  label: LOCALES[value].label
}))

/** 默认语言 */
const DEFAULT_LANG: Lang = 'zh-CN'

/** 主题 token 默认值 */
const DEFAULT_TOKEN: ThemeConfig['token'] = {
  colorPrimary: '#1677ff',
  borderRadius: 6
}

/** 除 locale / theme 之外的 ConfigProvider 选项 */
export const PROVIDER_OPTIONS = {
  componentSize: 'middle'
} satisfies Partial<ConfigProviderProps>

/** localStorage 持久化的 key */
const STORAGE_KEY = 'designer:config'

interface PersistedConfig {
  lang: Lang
  dark: boolean
}

// 模块级单例：整个渲染进程共用一份配置，并落盘到 localStorage
const state = useStorage<PersistedConfig>(
  STORAGE_KEY,
  { lang: DEFAULT_LANG, dark: false },
  undefined,
  { mergeDefaults: true }
)

// dayjs.locale() 是全局副作用，只能靠 watch 跟住 lang。
// 不写在 setter 里是因为 useStorage 还会被多窗口间的 storage
// 事件改动，那条路径绕不过 setter。
watch(
  () => state.value.lang,
  (next) => dayjs.locale(LOCALES[next].dayjs),
  { immediate: true }
)

/** ConfigProvider 用的 theme，同时也喂给 getDesignToken 算页面底色 */
const buildTheme = (dark: boolean): ThemeConfig => ({
  algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: { ...DEFAULT_TOKEN }
})

// ConfigProvider 的样式只作用在 .ant-app 内部，html / body 不归它管，
// 所以底色要自己算出来写到 CSS 变量上，否则暗色模式下页面周围还是白的。
watchEffect(() => {
  const { dark } = state.value
  const token = theme.getDesignToken(buildTheme(dark))
  const root = document.documentElement

  root.style.setProperty('--app-bg', token.colorBgLayout)
  root.style.setProperty('--app-text', token.colorText)
  // 让原生滚动条、表单控件跟着一起变
  root.style.colorScheme = dark ? 'dark' : 'light'
  // 供 tailwind 的 dark: 变体使用
  root.classList.toggle('dark', dark)
})

export function useAppConfig(): {
  lang: WritableComputedRef<Lang>
  dark: WritableComputedRef<boolean>
  antdLocale: ComputedRef<ConfigProviderProps['locale']>
  themeConfig: ComputedRef<ThemeConfig>
  langOptions: typeof LANG_OPTIONS
} {
  const lang = computed({
    get: () => state.value.lang,
    set: (next: Lang) => {
      state.value.lang = next
    }
  })

  const dark = computed({
    get: () => state.value.dark,
    set: (next: boolean) => {
      state.value.dark = next
    }
  })

  const antdLocale = computed(() => LOCALES[state.value.lang].antd)

  const themeConfig = computed<ThemeConfig>(() => buildTheme(state.value.dark))

  return { lang, dark, antdLocale, themeConfig, langOptions: LANG_OPTIONS }
}
