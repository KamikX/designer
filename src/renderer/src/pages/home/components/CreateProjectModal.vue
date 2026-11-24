<script setup lang="ts">
import LibraryPicker from '@renderer/components/libraries/LibraryPicker.vue'
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { useProjectStore } from '@renderer/stores/project'
import type { DesignTarget, PreviewLib, Stack } from '@shared/types'
import {
  buildCreateProjectInput,
  createDefaultProjectForm,
  resetProjectForm
} from './create-project'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message } = App.useApp()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{ created: [projectId: string] }>()

const { token } = theme.useToken()
const store = useProjectStore()

const form = reactive(createDefaultProjectForm())

/**
 * 组件库选择,目前只对 vue3 栈开放。勾了之后预览环境会通过 import map
 * 加载浏览器 ESM 构建,AI 的提示词里也会放开对应的 import 许可。
 */
const LIB_OPTIONS = computed<{ value: PreviewLib; label: string; hint: string }[]>(() => [
  {
    value: 'antdv-next',
    label: 'antdv-next',
    hint: t('组件库本体:按钮、表格、表单等')
  },
  {
    value: '@antdv-next/icons',
    label: '@antdv-next/icons',
    hint: t('配套图标库')
  }
])

function toggleLib(value: PreviewLib): void {
  const at = form.libs.indexOf(value)
  if (at >= 0) form.libs.splice(at, 1)
  else {
    form.libs.push(value)
    // 图标包依赖组件库的场景占绝大多数,勾图标顺手把本体带上
    if (value === '@antdv-next/icons' && !form.libs.includes('antdv-next')) {
      form.libs.push('antdv-next')
    }
  }
}

/**
 * 端类型多选。勾了哪些端,AI 就只加载哪些端的设计模板与交付契约——
 * 不勾也能创建,那时所有端模板都留在技能目录里等模型按需激活。
 */
const TARGET_OPTIONS = computed<{ value: DesignTarget; label: string; hint: string }[]>(() => [
  {
    value: 'landing',
    label: t('落地页'),
    hint: t('营销页 / 官网首页,讲一个故事,一个主 CTA')
  },
  {
    value: 'web',
    label: t('Web 应用'),
    hint: t('PC 端产品界面,键盘与 hover 是一等公民')
  },
  {
    value: 'mobile',
    label: t('移动端 App'),
    hint: t('真机框呈现,一屏一事,44px 点击目标')
  },
  {
    value: 'admin',
    label: t('中后台'),
    hint: t('管理系统,信息密度优先,表格与筛选')
  }
])

function toggleTarget(value: DesignTarget): void {
  const at = form.targets.indexOf(value)
  if (at >= 0) form.targets.splice(at, 1)
  else form.targets.push(value)
}

const STACK_OPTIONS = computed<{ value: Stack; label: string; hint: string }[]>(() => [
  {
    value: 'html',
    label: 'HTML',
    hint: t('自包含页面,预览最稳,适合视觉稿与营销页')
  },
  {
    value: 'vue3',
    label: 'Vue 3',
    hint: t('SFC 组件形态,适合落进 Vue 工程')
  },
  {
    value: 'react',
    label: 'React',
    hint: t('JSX 组件形态,适合落进 React 工程')
  }
])

const MODE_OPTIONS = computed(() => [
  { label: t('高质量 UI 设计'), value: 'design' },
  { label: t('快速原型'), value: 'prototype' }
])

const creating = ref(false)

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    message.warning(t('请输入项目名称'))
    return
  }
  creating.value = true
  try {
    const project = await store.create(buildCreateProjectInput(form))
    open.value = false
    resetProjectForm(form)
    emit('created', project.id)
  } catch (err) {
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="t('新建项目')"
    :confirm-loading="creating"
    :width="520"
    centered
    :ok-text="t('创建项目')"
    @ok="submit"
  >
    <!-- 表单项加到六组之后整体高度可能超过视口:弹窗本体封顶 80vh,
         超出的部分在这层内部滚,不把外面的页面顶出滚动条 -->
    <div class="create-body">
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item :label="t('项目名称')" required>
          <a-input
            v-model:value="form.name"
            size="large"
            :placeholder="t('如 官网改版 / 管理后台')"
            @press-enter="submit"
          />
        </a-form-item>

        <a-form-item :label="t('产物技术栈(创建后不可更改)')">
          <div class="stack-grid">
            <div
              v-for="opt in STACK_OPTIONS"
              :key="opt.value"
              class="stack-item"
              :class="{ 'stack-item--active': form.stack === opt.value }"
              :style="
                form.stack === opt.value
                  ? {
                      borderColor: token.colorText,
                      boxShadow: `0 0 0 1px ${token.colorText}`,
                      background: token.colorFillQuaternary
                    }
                  : { borderColor: token.colorBorderSecondary }
              "
              @click="form.stack = opt.value"
            >
              <!--
                不给每个技术栈配一套颜色:那个颜色不表达任何状态,HTML 是橙的、
                Vue 是绿的纯属装饰。选中与否用描边深浅和底色说,颜色留给状态。
              -->
              <span class="stack-item-label">{{ opt.label }}</span>
              <span class="stack-item-hint" :style="{ color: token.colorTextTertiary }">
                {{ opt.hint }}
              </span>
            </div>
          </div>
        </a-form-item>

        <a-form-item :label="t('设计模式')">
          <a-segmented v-model:value="form.designMode" :options="MODE_OPTIONS" block />
        </a-form-item>

        <a-form-item v-if="form.stack === 'vue3'" :label="t('可选依赖包(预览环境自动加载)')">
          <div class="target-grid">
            <div
              v-for="opt in LIB_OPTIONS"
              :key="opt.value"
              class="target-item"
              :style="
                form.libs.includes(opt.value)
                  ? {
                      borderColor: token.colorPrimary,
                      boxShadow: `0 0 0 1px ${token.colorPrimary}`
                    }
                  : { borderColor: token.colorBorderSecondary }
              "
              @click="toggleLib(opt.value)"
            >
              <span
                class="target-item-label"
                :style="{
                  color: form.libs.includes(opt.value) ? token.colorPrimary : token.colorText
                }"
              >
                {{ opt.label }}
              </span>
              <span class="target-item-hint" :style="{ color: token.colorTextTertiary }">
                {{ opt.hint }}
              </span>
            </div>
          </div>
        </a-form-item>

        <a-form-item v-if="form.stack !== 'html'" :label="t('依赖库')">
          <LibraryPicker :key="form.stack" v-model="form.externalLibraries" :stack="form.stack" />
        </a-form-item>

        <a-form-item :label="t('设计端类型(可多选,决定 AI 加载哪些端的设计规范)')">
          <div class="target-grid">
            <div
              v-for="opt in TARGET_OPTIONS"
              :key="opt.value"
              class="target-item"
              :style="
                form.targets.includes(opt.value)
                  ? {
                      borderColor: token.colorPrimary,
                      boxShadow: `0 0 0 1px ${token.colorPrimary}`
                    }
                  : { borderColor: token.colorBorderSecondary }
              "
              @click="toggleTarget(opt.value)"
            >
              <span
                class="target-item-label"
                :style="{
                  color: form.targets.includes(opt.value) ? token.colorPrimary : token.colorText
                }"
              >
                {{ opt.label }}
              </span>
              <span class="target-item-hint" :style="{ color: token.colorTextTertiary }">
                {{ opt.hint }}
              </span>
            </div>
          </div>
        </a-form-item>

        <a-form-item :label="t('项目描述')">
          <a-textarea
            v-model:value="form.description"
            :rows="3"
            :placeholder="t('一句话说明这个项目要做什么,会作为 AI 的背景信息')"
          />
        </a-form-item>

        <a-form-item
          :label="t('视觉风格（可选）')"
          :extra="
            t('可描述色彩、明暗、信息密度、字体、圆角、动效等；留空时，AI 会在首次生成前询问。')
          "
        >
          <a-textarea
            v-model:value="form.styleBrief"
            :rows="4"
            :placeholder="t('如：深色工业感，高信息密度，紧凑无衬线字体，卡片近直角，动效克制')"
          />
        </a-form-item>
      </a-form>
    </div>
  </a-modal>
</template>

<style scoped>
/* 弹窗本体不超过 80vh:减去标题栏与底部按钮区约 120px,剩下的给表单内滚 */
.create-body {
  max-height: calc(80vh - 120px);
  overflow-y: auto;
  overscroll-behavior: contain;
  /*
   * 滚动容器会把溢出到边界外的内容裁掉——技术栈/端类型/依赖包卡片的选中
   * 描边是 1px box-shadow,画在卡片边框**外侧**,贴边的卡片描边就被裁了。
   * 四周留 2px 让描边画得下,再用负 margin 抵消,布局不变;
   * 右侧多留一点给滚动条,别压着表单控件。
   */
  padding: 2px 6px 2px 2px;
  margin: -2px -6px -2px -2px;
}

.stack-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.stack-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.stack-item-label {
  font-weight: 600;
  font-size: 13px;
}

.stack-item-hint {
  font-size: 12px;
  line-height: 1.5;
}

.target-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.target-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.target-item-label {
  font-weight: 600;
  font-size: 13px;
}

.target-item-hint {
  font-size: 12px;
  line-height: 1.5;
}
</style>
