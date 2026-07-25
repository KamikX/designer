<script setup lang="ts">
import { App as AntdApp, ConfigProvider } from 'antdv-next'
import { useAppConfig, PROVIDER_OPTIONS } from './config'

/**
 * 全局配置壳：ConfigProvider + App。
 *
 * 本身不接受任何 props —— 要改配置去 ./config.ts。
 * App 必须是 ConfigProvider 的子级，否则 useApp() 拿到的
 * message / modal / notification 读不到主题 token。
 */
const { antdLocale, themeConfig } = useAppConfig()

/**
 * 给「组件外的命令式调用」兜底。
 *
 * `App.useApp()` 是首选,但它靠 inject,只有在 setup 里才拿得到——store、
 * 路由守卫、工具函数里根本调不了。那些地方只能用静态的 `message.error(...)`,
 * 而静态实例是挂在组件树之外的,默认读不到我们的主题和语言:暗色模式下弹出
 * 一条亮色的提示,中文界面弹出英文按钮。
 *
 * ConfigProvider.config() 就是给这份静态实例喂配置的。三项各有用处:
 * - theme / locale 放在 watchEffect 里,跟着用户的设置走。写死在启动那一刻
 *   的话,切暗色 / 切语言之后静态实例还停在旧值上
 * - appContext 让静态实例能解析到本应用注册的全局组件和插件。**它只能在
 *   组件 setup 里通过 getCurrentInstance() 取到**,这也是这段代码放在这里、
 *   而没有收进 config.ts 的唯一原因
 */
const appContext = getCurrentInstance()?.appContext

watchEffect(() => {
  ConfigProvider.config({
    theme: themeConfig.value,
    ...(antdLocale.value ? { locale: antdLocale.value } : {}),
    ...(appContext ? { appContext } : {})
  })
})
</script>

<template>
  <ConfigProvider v-bind="PROVIDER_OPTIONS" :locale="antdLocale" :theme="themeConfig">
    <!-- ConfigProvider 只做 provide 不渲染 DOM，但 App 会渲染一个没有高度的
         div，高度链会在这里断掉，所以要显式把它撑满 -->
    <AntdApp class="h-full">
      <slot />
    </AntdApp>
  </ConfigProvider>
</template>
