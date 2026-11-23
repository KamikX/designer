import { t, bindLanguage } from '@renderer/i18n'
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
    get label() {
      return t('推荐')
    },
    colors: ['#1677ff', '#5b8ff9', '#00b96b', '#13c2c2', '#722ed1', '#eb2f96', '#fa541c', '#faad14']
  }
]

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
bindLanguage(computed(() => state.lang))
watch(
  () => state.lang,
  (lang) => {
    document.documentElement.lang = lang
  },
  { immediate: true }
)

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

/**
 * 毛玻璃下各层表面的不透明度：太高就看不出玻璃，太低字会糊。
 *
 * `canvas` 这一层是后补的,补的是一个不小的问题:画布原来直接设成
 * transparent,于是整块底色就是**系统 vibrancy 的中性冷灰**——tokens.css
 * 里调了半天的暖纸一次都没被画出来,而且颜色还跟着用户的桌面壁纸变,
 * 同一个应用在两台机器上是两个色温。
 *
 * 铺一层 84% 的暖纸:vibrancy 的深度感还在(边缘和窗后的明暗仍透得上来),
 * 但色温回到我们自己手里。
 */
const GLASS_ALPHA = { canvas: 0.84, rail: 0.62, container: 0.72 }

const alpha = (color: string, a: number): string =>
  `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`

/**
 * ConfigProvider 用的 theme,同时也喂给 getDesignToken 算页面底色。
 *
 * ## 为什么要覆盖这么多
 *
 * 只改 colorPrimary 的话,剩下 32 个 seed token 全是 antd 默认值——**所有用
 * antd 的应用会长成同一个样子**,换个主色也救不回来。真正拉开差距的是中性色的
 * 色温、字体、圆角、控件密度和动效曲线。
 *
 * ## 中性色靠 seed 带偏,不是逐个覆盖
 *
 * colorBgBase / colorTextBase 是算法的输入。把它们设成暖色(色相 ~40°),整条
 * 中性色阶就会跟着暖起来;然后**只把描边单独扳回冷色**(~215°)。
 * 暖纸配冷发丝线,这是"贵"和"廉价"之间最大的一个差别,而改动只有几行。
 *
 * 具体值见 assets/tokens.css 的说明。
 */
const buildTheme = (dark: boolean, primaryColor: string): ThemeConfig => ({
  algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: {
    colorPrimary: primaryColor,

    // 中性色的色温:暖底暖字
    colorBgBase: dark ? '#1a1917' : '#faf9f7',
    colorTextBase: dark ? '#e8e4dc' : '#1a1916',

    // 描边扳回冷色。亮色下用实色,暗色下用半透明白——暗底上实色描边会显脏
    colorBorder: dark ? '#46433c' : '#c9d0da',
    colorBorderSecondary: dark ? 'rgba(255,255,255,0.08)' : '#e1e5eb',

    /*
     * 字体。标题用衬线是在别处(见 base.css 的 h1-h3),这里定的是界面字体。
     * 不引 webfont:11-13px 这个尺寸上系统字体的渲染比任何下载来的字体都好,
     * 而且是 0 字节。
     */
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', Roboto, sans-serif",
    fontFamilyCode: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",

    // 密度:界面文字压到 13px,控件 28px。桌面工具的信息密度本来就该比网页高
    fontSize: 13,
    controlHeight: 28,
    borderRadius: 8,

    /*
     * 动效:**一条曲线用到底**。
     * antd 默认那几条各不相同,混在一起会让界面显得"没有统一手感"。
     * 进场 200ms、出场 140ms——用户已经决定关掉它了,不该再等。
     */
    motionEaseInOut: 'cubic-bezier(0.23, 1, 0.32, 1)',
    motionEaseOut: 'cubic-bezier(0.23, 1, 0.32, 1)',
    motionDurationFast: '0.12s',
    motionDurationMid: '0.2s',
    motionDurationSlow: '0.28s'
  },
  components: {
    // 组件级微调:让卡片默认扁平,阴影留给悬停和浮层
    Card: { boxShadowTertiary: 'none' },
    Button: { primaryShadow: 'none', defaultShadow: 'none' },
    Segmented: { itemSelectedBg: 'var(--bg-elevated)' },
    /*
     * 侧栏选中态**不用品牌色**。
     *
     * 默认是"浅蓝底 + 蓝图标",于是一整片中性灰里唯一的高饱和色用来说
     * "你在哪一页"——那不是状态,是层级,层级该由填充深浅和字重来说。
     * 颜色留给真正的状态(生成中、出错、主行动按钮)。
     */
    Menu: {
      itemSelectedBg: 'var(--fill)',
      itemSelectedColor: 'var(--text-strong)',
      itemHoverBg: 'var(--fill-subtle)',
      itemColor: 'var(--text-muted)',
      itemHoverColor: 'var(--text)'
    }
  }
})

// ConfigProvider 的样式只作用在 .ant-app 内部，html / body 不归它管，
// 所以底色要自己算出来写到 CSS 变量上，否则暗色模式下页面周围还是白的。
watchEffect(() => {
  const { dark, primaryColor } = state
  const token = theme.getDesignToken(buildTheme(dark, primaryColor))
  const root = document.documentElement

  /*
   * 画布与导轨的底色**取自 tokens.css,不用 antd 派生的那份**。
   *
   * 实测:把 colorBgBase 设成暖纸 #faf9f7 之后,算法派生出来的 colorBgLayout
   * 是 #efeeee——R239 G238 B238,几乎纯中性。"seed 设暖整条色阶跟着暖"这个
   * 假设在**最大的那块面积**上不成立,于是整个应用看着发灰发冷,而 tokens.css
   * 里调好的暖纸从来没被画出来过。
   *
   * 毛玻璃下不能上不透明底色(会把 vibrancy 整个盖掉),所以铺一层高不透明度的
   * 暖纸:色温归我们,深度感归 vibrancy。var() 会自己跟着 .dark 翻转。
   */
  root.style.setProperty(
    '--app-bg',
    GLASS_ENABLED ? alpha('var(--bg)', GLASS_ALPHA.canvas) : 'var(--bg)'
  )
  root.style.setProperty(
    '--app-rail-bg',
    GLASS_ENABLED
      ? // 抬起来的暖白面,不是纯白:纯白在暖底上是一块冷斑,
        // 而这条导轨占着整个左边缘,它偏冷整个应用就偏冷
        alpha('var(--bg-panel)', GLASS_ALPHA.rail)
      : 'var(--bg-panel)'
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
