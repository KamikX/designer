import type { CreateProjectInput, DesignMode, DesignTarget, PreviewLib, Stack } from '@shared/types'

export const STYLE_BRIEF_FIELD_LABEL = '视觉风格（可选）'

export interface CreateProjectForm {
  name: string
  stack: Stack
  designMode: DesignMode
  targets: DesignTarget[]
  libs: PreviewLib[]
  description: string
  styleBrief: string
}

export function createDefaultProjectForm(): CreateProjectForm {
  return {
    name: '',
    stack: 'html',
    designMode: 'design',
    // 默认勾 web:targets 为空时端契约与端模板一个字都不注入,模型拿到的
    // 设计指导骤降。用户建移动端/落地页项目时自己改勾选即可
    targets: ['web'],
    libs: [],
    description: '',
    styleBrief: ''
  }
}

/** 保留 reactive 容器本身，仅把字段恢复成新建项目的默认状态。 */
export function resetProjectForm(form: CreateProjectForm): void {
  Object.assign(form, createDefaultProjectForm())
}

/** 将表单状态整理成稳定的创建契约，避免 UI 分支把残留值带给主进程。 */
export function buildCreateProjectInput(form: CreateProjectForm): CreateProjectInput {
  return {
    name: form.name.trim(),
    stack: form.stack,
    designMode: form.designMode,
    targets: [...form.targets],
    // 组件库只在 vue3 栈有意义；切过栈的话别把残留勾选带进去
    libs: form.stack === 'vue3' ? [...form.libs] : [],
    description: form.description.trim(),
    styleBrief: form.styleBrief.trim()
  }
}
