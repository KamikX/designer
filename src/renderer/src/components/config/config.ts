import type { ConfigProviderProps, ThemeConfig } from 'antdv-next'
import type { ComputedRef, WritableComputedRef } from 'vue'
import { theme } from 'antdv-next'
import enUS from 'antdv-next/locale/en_US'
import zhCN from 'antdv-next/locale/zh_CN'
import dayjs from 'dayjs'
import { computed, reactive, watch, watchEffect } from 'vue'
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

/** 默认主题色，"重置"用 */
const DEFAULT_PRIMARY_COLOR = '#1677ff'

/** 主题色预设，供 ColorPicker 的色板使用 */
export const COLOR_PRESETS = [
  {
    label: '推荐',
    colors: ['#1677ff', '#5b8ff9', '#00b96b', '#13c2c2', '#722ed1', '#eb2f96', '#fa541c', '#faad14']
  }
]

/** 除主题色以外的 token 默认值 */
const DEFAULT_TOKEN: ThemeConfig['token'] = {
  borderRadius: 6
}

/** 除 locale / theme 之外的 ConfigProvider 选项 */
export const PROVIDER_OPTIONS = {
  componentSize: 'middle'
} satisfies Partial<ConfigProviderProps>

/**
 * 模块级单例，整个渲染进程共用一份配置。
 *
 * 落盘在主进程的 ~/.antd-designer/config.json，不再用 localStorage——
 * 主进程读不到 localStorage，就没法在建窗口前定好明暗，毛玻璃和底色
 * 会在启动瞬间闪一下。初始值由 preload 同步取好，首帧即正确。
 */
const state = reactive({ ...window.api.initialConfig })

/** 写回主进程。IPC 是异步的，本地状态先改，UI 不等落盘 */
const persist = (): void => {
  void window.api.config.patch({
    lang: state.lang,
    dark: state.dark,
    primaryColor: state.primaryColor
  })
}

// dayjs.locale() 是全局副作用，只能靠 watch 跟住 lang
watch(
  () => state.lang,
  (next) => dayjs.locale(LOCALES[next].dayjs),
  { immediate: true }
)

/**
 * 是否启用毛玻璃。
 *
 * macOS 的 vibrancy 和 Windows 11 的 acrylic 才有原生毛玻璃，
 * Linux / Win10 没有，退回不透明底色，否则会看到窗口漏底。
 */
const platform = window.electron.process.platform
export const GLASS_ENABLED = platform === 'darwin' || platform === 'win32'

/** 毛玻璃下各层表面的不透明度：太高就看不出玻璃，太低字会糊 */
const GLASS_ALPHA = { rail: 0.55, container: 0.72 }

const alpha = (color: string, a: number): string =>
  `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`

/** ConfigProvider 用的 theme，同时也喂给 getDesignToken 算页面底色 */
const buildTheme = (dark: boolean, primaryColor: string): ThemeConfig => ({
  algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: {
    ...DEFAULT_TOKEN,
    colorPrimary: primaryColor,
    // 卡片、弹层这些容器要半透明，玻璃才透得上来。
    // 弹出层（Modal / Dropdown）保持不透明，浮在玻璃上更清楚。
    ...(GLASS_ENABLED ? { colorBgContainer: alpha(dark ? '#141414' : '#ffffff', 0.72) } : {})
  }
})

// ConfigProvider 的样式只作用在 .ant-app 内部，html / body 不归它管，
// 所以底色要自己算出来写到 CSS 变量上，否则暗色模式下页面周围还是白的。
watchEffect(() => {
  const { dark, primaryColor } = state
  const token = theme.getDesignToken(buildTheme(dark, primaryColor))
  const root = document.documentElement

  // 开了毛玻璃时页面底色必须透明，任何不透明背景都会把 vibrancy 整个盖掉
  root.style.setProperty('--app-bg', GLASS_ENABLED ? 'transparent' : token.colorBgLayout)
  root.style.setProperty(
    '--app-rail-bg',
    GLASS_ENABLED
      ? alpha(dark ? token.colorBgElevated : '#ffffff', GLASS_ALPHA.rail)
      : dark
        ? token.colorBgElevated
        : token.colorFillQuaternary
  )
  root.style.setProperty('--app-text', token.colorText)
  root.style.setProperty('--app-primary', token.colorPrimary)
  root.style.setProperty('--app-border', token.colorBorderSecondary)
  // 让原生滚动条、表单控件跟着一起变
  root.style.colorScheme = dark ? 'dark' : 'light'
  // 供 tailwind 的 dark: 变体使用
  root.classList.toggle('dark', dark)
})

export function useAppConfig(): {
  lang: WritableComputedRef<Lang>
  dark: WritableComputedRef<boolean>
  primaryColor: WritableComputedRef<string>
  antdLocale: ComputedRef<ConfigProviderProps['locale']>
  themeConfig: ComputedRef<ThemeConfig>
  langOptions: typeof LANG_OPTIONS
  colorPresets: typeof COLOR_PRESETS
  resetTheme: () => void
} {
  const lang = computed({
    get: () => state.lang,
    set: (next: Lang) => {
      state.lang = next
      persist()
    }
  })

  const dark = computed({
    get: () => state.dark,
    set: (next: boolean) => {
      state.dark = next
      persist()
    }
  })

  const primaryColor = computed({
    get: () => state.primaryColor,
    set: (next: string) => {
      state.primaryColor = next
      persist()
    }
  })

  const antdLocale = computed(() => LOCALES[state.lang].antd)

  const themeConfig = computed<ThemeConfig>(() => buildTheme(state.dark, state.primaryColor))

  const resetTheme = (): void => {
    state.dark = false
    state.primaryColor = DEFAULT_PRIMARY_COLOR
    persist()
  }

  return {
    lang,
    dark,
    primaryColor,
    antdLocale,
    themeConfig,
    langOptions: LANG_OPTIONS,
    colorPresets: COLOR_PRESETS,
    resetTheme
  }
}
