<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import type { InstalledSkill, Model, Provider } from '@shared/types'
import type { MemberDraft } from '../member-drafts'

interface ModelGroup {
  provider: Provider
  models: Model[]
}

const props = defineProps<{
  modelGroups: readonly ModelGroup[]
  skills: readonly InstalledSkill[]
}>()

const member = defineModel<MemberDraft>({ required: true })
const { token } = theme.useToken()

const modelOptions = computed(() =>
  props.modelGroups
    .map(({ provider, models }) => ({
      label: provider.name,
      options: models
        .filter(
          (model) => model.enabled && model.type === 'chat' && model.abilities.includes('tools')
        )
        .map((model) => ({ label: model.displayName, value: model.id }))
    }))
    .filter((group) => group.options.length > 0)
)

const SOURCE_LABELS = computed<Record<InstalledSkill['source'], string>>(() => ({
  // 内置领域技能包排最前:这是群组场景的主打能力,用户自己的技能其次
  'builtin-pm': t('项目管理(内置)'),
  'builtin-ui': t('UI 设计(内置)'),
  'builtin-fullstack': t('全栈工程(内置)'),
  'builtin-agent': t('工程方法(内置)'),
  // 设计会话里自动启用的 builtin 设计技能,群组里不自动、但可以手动勾
  builtin: t('设计生成(内置)'),
  app: t('我的技能'),
  agents: t('Agents 共享技能'),
  claude: t('Claude 技能')
}))

const skillOptions = computed(() => {
  const selectable = props.skills
  const groups = (Object.keys(SOURCE_LABELS.value) as (keyof typeof SOURCE_LABELS.value)[]).flatMap(
    (source) => {
      const options = selectable
        .filter((skill) => skill.source === source)
        .map((skill) => ({
          label: skill.name,
          value: skill.name,
          title: skill.description
        }))
      return options.length > 0 ? [{ label: SOURCE_LABELS.value[source], options }] : []
    }
  )

  // 技能被卸载后仍保留一个可删除的选项，避免 Select 把未知值显示得像脏数据。
  const installedNames = new Set(selectable.map((skill) => skill.name))
  const missing = member.value.skillIds
    .filter((name) => !installedNames.has(name))
    .map((name) => ({
      get label() {
        return t('{0}（已卸载）', name)
      },
      value: name
    }))
  return missing.length > 0
    ? [
        ...groups,
        {
          get label() {
            return t('已失效')
          },
          options: missing
        }
      ]
    : groups
})

/**
 * 头像色板:内置角色模板的五个颜色 + 常用主色。用 presets 而不是让用户
 * 在色轮上瞎点——群成员头像要在一排里互相区分,给一组挑好的比自由取色
 * 更容易得到好结果;当然色板外仍可自由选。
 */
const COLOR_PRESETS = [
  {
    get label() {
      return t('推荐')
    },
    colors: ['#e8662c', '#722ed1', '#2f7fd6', '#31a06e', '#b23a48', '#1677ff', '#d4a017', '#13a8a8']
  }
]

type TextField = 'name' | 'color' | 'duty' | 'deliverable' | 'persona'

function updateText(field: TextField, value: unknown): void {
  member.value = {
    ...member.value,
    [field]: typeof value === 'string' ? value : String(value ?? ''),
    skillIds: [...member.value.skillIds]
  }
}

function updateModel(value: unknown): void {
  member.value = {
    ...member.value,
    modelRowId: typeof value === 'string' ? value : '',
    skillIds: [...member.value.skillIds]
  }
}

function updateSkills(value: unknown): void {
  const skillIds = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
  member.value = { ...member.value, skillIds }
}
</script>

<template>
  <div class="member-editor" :style="{ borderColor: token.colorBorderSecondary }">
    <div class="member-editor-title">{{ t('编辑成员') }}</div>
    <a-form layout="vertical" size="small">
      <div class="member-editor-grid">
        <a-form-item :label="t('名称')" html-for="member-name" required>
          <a-input
            id="member-name"
            :aria-label="t('成员名称')"
            data-testid="member-name"
            :value="member.name"
            :maxlength="24"
            :placeholder="t('如 需求策划')"
            @update:value="updateText('name', $event)"
          />
        </a-form-item>
        <a-form-item :label="t('头像颜色')" html-for="member-color">
          <!-- valueFormat="hex":update:value 直接回 hex 字符串,存储形状不变 -->
          <a-color-picker
            id="member-color"
            :aria-label="t('成员头像颜色')"
            data-testid="member-color"
            :value="member.color"
            value-format="hex"
            disabled-alpha
            show-text
            :presets="COLOR_PRESETS"
            @update:value="updateText('color', $event)"
          />
        </a-form-item>
      </div>

      <a-form-item :label="t('职责')" html-for="member-duty">
        <a-input
          id="member-duty"
          :aria-label="t('成员职责')"
          data-testid="member-duty"
          :value="member.duty"
          :placeholder="t('一句话说明负责什么')"
          @update:value="updateText('duty', $event)"
        />
      </a-form-item>
      <a-form-item :label="t('产出物')" html-for="member-deliverable">
        <a-input
          id="member-deliverable"
          :aria-label="t('成员产出物')"
          data-testid="member-deliverable"
          :value="member.deliverable"
          :placeholder="t('如 需求文档')"
          @update:value="updateText('deliverable', $event)"
        />
      </a-form-item>
      <a-form-item :label="t('人设')" html-for="member-persona" required>
        <a-textarea
          id="member-persona"
          :aria-label="t('成员人设')"
          data-testid="member-persona"
          :value="member.persona"
          :auto-size="{ minRows: 4, maxRows: 8 }"
          :placeholder="t('说明成员的专业背景、工作方式与交付要求')"
          @update:value="updateText('persona', $event)"
        />
      </a-form-item>
      <a-form-item :label="t('模型')" html-for="member-model" required>
        <a-select
          id="member-model"
          :aria-label="t('成员模型')"
          data-testid="member-model"
          :value="member.modelRowId || undefined"
          :options="modelOptions"
          show-search
          option-filter-prop="label"
          :placeholder="t('选择支持工具调用的模型')"
          @update:value="updateModel"
        />
      </a-form-item>
      <a-form-item
        :label="t('技能')"
        html-for="member-skills"
        :extra="t('群组不会自动启用任何技能，内置技能也只在勾选后生效。')"
      >
        <a-select
          id="member-skills"
          :aria-label="t('成员技能')"
          data-testid="member-skills"
          :value="member.skillIds"
          :options="skillOptions"
          mode="multiple"
          show-search
          option-filter-prop="label"
          :placeholder="t('搜索并选择技能')"
          @update:value="updateSkills"
        />
      </a-form-item>
    </a-form>
  </div>
</template>

<style scoped>
.member-editor {
  min-width: 0;
  padding: 14px;
  border: 1px solid;
  border-radius: 12px;
}

.member-editor-title {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
}

.member-editor-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px;
  gap: 10px;
}

.member-editor :deep(.ant-form-item) {
  margin-bottom: 12px;
}
</style>
