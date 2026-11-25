import type {
  CreateProjectInput,
  DesignMode,
  DesignTarget,
  ExternalLibraryRef,
  PreviewLib,
  Stack,
  VisualStylePriority
} from '@shared/types'

export const STYLE_BRIEF_FIELD_LABEL = 'common.visualStyle'

export interface CreateProjectForm {
  name: string
  stack: Stack
  designMode: DesignMode
  targets: DesignTarget[]
  externalLibraries: ExternalLibraryRef[]
  libs: PreviewLib[]
  description: string
  styleBrief: string
  designDocument: string
  visualStylePriority: VisualStylePriority
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
    externalLibraries: [],
    description: '',
    styleBrief: '',
    designDocument: '',
    visualStylePriority: 'styleBrief'
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
    externalLibraries:
      form.stack === 'html'
        ? []
        : form.externalLibraries.map((ref) => ({ name: ref.name, version: ref.version })),
    libs: form.stack === 'vue3' ? [...form.libs] : [],
    description: form.description.trim(),
    styleBrief: form.styleBrief.trim(),
    designDocument: form.designDocument,
    visualStylePriority: form.visualStylePriority
  }
}

/** Component deliverables need their own contract rather than page-target templates. */
export function toggleProjectTarget(form: CreateProjectForm, value: DesignTarget): void {
  if (form.targets.includes(value)) {
    form.targets = form.targets.filter((target) => target !== value)
  } else if (value === 'components') {
    form.targets = ['components']
  } else {
    form.targets = [...form.targets.filter((target) => target !== 'components'), value]
  }
}
