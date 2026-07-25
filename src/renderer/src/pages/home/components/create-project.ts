import type { CreateProjectInput, DesignMode, DesignTarget, PreviewLib, Stack } from '@shared/types'

export interface CreateProjectForm {
  name: string
  stack: Stack
  designMode: DesignMode
  targets: DesignTarget[]
  libs: PreviewLib[]
  description: string
  styleBrief: string
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
