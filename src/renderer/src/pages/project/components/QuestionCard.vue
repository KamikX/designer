<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { CheckOutlined } from '@antdv-next/icons'
import type { AskUserAnswer, AskUserInput } from '@shared/types'

/**
 * AI 的提问卡片。
 *
 * 主进程的工具循环此刻正停在 ask_user 那一步等这张卡片的结果,所以
 * 交互目标只有一个:**让用户几秒钟内点完**。为此:
 * - 选项是点一下就选中的大块按钮,不是 radio 小圆点
 * - 单选选完不自动提交——多题卡片里自动提交会让人来不及看第二题
 * - 「跳过」和「提交」一样显眼:不想答比答错更值得尊重
 *
 * 答完之后卡片留在原地变成只读摘要,历史回放时也走这个分支。
 */

const props = defineProps<{
  ask: AskUserInput
  /** 非 null 表示已作答,卡片转只读 */
  answer: AskUserAnswer | null
  /** 这轮流已经结束了(中止 / 出错),卡片不再可交互 */
  stale?: boolean
}>()

const emit = defineEmits<{ submit: [AskUserAnswer] }>()

const { token } = theme.useToken()

/** 每题选中的标签 */
const picked = ref<string[][]>(props.ask.questions.map(() => []))
/** 每题的自定义输入 */
const custom = ref<string[]>(props.ask.questions.map(() => ''))
const notes = ref('')

/**
 * 密钥输入。
 *
 * 值只在这个组件里活到提交那一刻,提交后主进程立刻剥离进加密存储,**不写进
 * 消息历史**。所以已答态里永远看不到它们——那是对的,不是显示丢了。
 */
const secrets = ref<Record<string, string>>(
  Object.fromEntries((props.ask.secrets ?? []).map((s) => [s.key, '']))
)
const submitting = ref(false)

const locked = computed(() => props.answer !== null || props.stale === true)

function isPicked(index: number, label: string): boolean {
  return picked.value[index].includes(label)
}

function toggle(index: number, label: string): void {
  if (locked.value) return
  const question = props.ask.questions[index]
  const current = picked.value[index]
  if (question.kind === 'single') {
    picked.value[index] = current.includes(label) ? [] : [label]
    return
  }
  picked.value[index] = current.includes(label)
    ? current.filter((l) => l !== label)
    : [...current, label]
}

/**
 * 自定义输入有内容就算这一题的一个选项。
 *
 * **每一层都要展开成普通数组**:直接返回 picked.value[index] 会把响应式
 * 代理漏出去,这个结果最终要过 IPC,而 structured clone 克隆不了 Proxy——
 * 报错是 "An object could not be cloned",且发生在 store 里,离这里很远。
 */
const selections = computed(() =>
  props.ask.questions.map((_, index) => {
    const extra = custom.value[index].trim()
    return extra ? [...picked.value[index], extra] : [...picked.value[index]]
  })
)

const canSubmit = computed(() => {
  // 有必填的密钥就必须填完:少填一个,装出来的服务会带着空 token 启动,
  // 然后报一个和"没配密钥"毫不相干的认证错误
  const secretsFilled = (props.ask.secrets ?? []).every((s) => secrets.value[s.key]?.trim())
  if (!secretsFilled) return false
  return (
    selections.value.some((s) => s.length > 0) || notes.value.trim() || props.ask.secrets?.length
  )
})

function submit(skipped = false): void {
  if (locked.value || submitting.value) return
  submitting.value = true
  emit('submit', {
    selections: skipped ? [] : selections.value,
    notes: skipped ? undefined : notes.value.trim() || undefined,
    // 摊成普通对象:IPC 是 structured clone,克隆不了响应式代理
    ...(skipped || !props.ask.secrets?.length ? {} : { secrets: { ...secrets.value } }),
    ...(skipped ? { skipped: true } : {})
  })
}

/** 已答态展示用:优先用存下来的答案 */
const shown = computed(() => props.answer?.selections ?? selections.value)
</script>

<template>
  <div
    class="question-card"
    :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
  >
    <div v-if="ask.intro" class="question-intro">{{ ask.intro }}</div>

    <!-- 已答:只留摘要,不占地方 -->
    <template v-if="answer">
      <div v-if="answer.skipped" class="question-skipped">
        {{ t('messages.skippedAiWillContinueUsingItsOwnJudgment') }}
      </div>
      <template v-else>
        <div v-for="(q, i) in ask.questions" :key="i" class="question-summary">
          <span class="question-summary-label" :style="{ color: token.colorTextSecondary }">
            {{ q.header }}
          </span>
          <span>{{ shown[i]?.join('、') || t('common.notSelected') }}</span>
        </div>
        <div v-if="answer.notes" class="question-summary">
          <span class="question-summary-label" :style="{ color: token.colorTextSecondary }">
            {{ t('common.additionalDetails') }}
          </span>
          <span>{{ answer.notes }}</span>
        </div>
      </template>
    </template>

    <!-- 待答 -->
    <template v-else>
      <div v-for="(q, i) in ask.questions" :key="i" class="question-block">
        <div class="question-title">
          {{ q.question }}
          <span v-if="q.kind === 'multiple'" class="question-hint">{{
            t('common.multipleSelectionsAllowed')
          }}</span>
        </div>

        <div class="question-options">
          <button
            v-for="option in q.options"
            :key="option.label"
            type="button"
            class="question-option"
            :disabled="locked"
            :style="
              isPicked(i, option.label)
                ? {
                    borderColor: token.colorPrimary,
                    background: token.colorPrimaryBg,
                    color: token.colorPrimary
                  }
                : { borderColor: token.colorBorderSecondary }
            "
            @click="toggle(i, option.label)"
          >
            <span class="question-option-label">
              <CheckOutlined v-if="isPicked(i, option.label)" style="font-size: 11px" />
              {{ option.label }}
            </span>
            <span
              v-if="option.description"
              class="question-option-desc"
              :style="{ color: token.colorTextTertiary }"
            >
              {{ option.description }}
            </span>
          </button>
        </div>

        <a-input
          v-if="q.allowCustom"
          v-model:value="custom[i]"
          :disabled="locked"
          size="small"
          :placeholder="t('messages.orEnterYourOwnAnswer')"
          style="margin-top: 6px"
        />
      </div>

      <!-- 密钥:密码框,值不进消息历史 -->
      <div v-for="secret in ask.secrets ?? []" :key="secret.key" class="question-block">
        <div class="question-title">{{ secret.label }}</div>
        <a-input-password
          v-model:value="secrets[secret.key]"
          :disabled="locked"
          :placeholder="secret.key"
          autocomplete="off"
        />
        <div v-if="secret.help" class="question-secret-help">{{ secret.help }}</div>
        <div class="question-secret-help">
          {{ t('messages.encryptedLocallyNeverIncludedInConversationHistory') }}
        </div>
      </div>

      <div v-if="ask.notes" class="question-block">
        <div class="question-title">{{ ask.notes.label }}</div>
        <a-textarea
          v-model:value="notes"
          :disabled="locked"
          :rows="2"
          :placeholder="ask.notes.placeholder ?? t('messages.anythingElseAiShouldKnow')"
        />
      </div>

      <div class="question-actions">
        <a-button size="small" :disabled="locked" @click="submit(true)">{{
          t('common.skip')
        }}</a-button>
        <a-button
          type="primary"
          size="small"
          :disabled="locked || !canSubmit"
          :loading="submitting"
          @click="submit(false)"
        >
          {{ t('common.submit') }}
        </a-button>
      </div>
      <div v-if="stale" class="question-skipped">
        {{ t('messages.thisTurnHasEndedTheQuestionIsNoLongerActive') }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.question-secret-help {
  font-size: 11px;
  opacity: 0.55;
  margin-top: 4px;
}

.question-card {
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 12px;
  margin-top: 8px;
  font-size: 13px;
}

.question-intro {
  font-size: 12px;
  opacity: 0.7;
  line-height: 1.7;
  margin-bottom: 10px;
}

.question-block + .question-block {
  margin-top: 14px;
}

.question-title {
  font-weight: 600;
  margin-bottom: 7px;
  line-height: 1.6;
}

.question-hint {
  font-weight: 400;
  font-size: 11px;
  opacity: 0.5;
  margin-left: 6px;
}

.question-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.question-option {
  flex: 1 1 132px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 7px 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.question-option:disabled {
  cursor: default;
}

.question-option:not(:disabled):hover {
  border-color: var(--app-primary);
}

.question-option-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
}

.question-option-desc {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
}

.question-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.question-summary {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.9;
}

.question-summary-label {
  flex-shrink: 0;
  min-width: 42px;
}

.question-skipped {
  font-size: 12px;
  opacity: 0.5;
  margin-top: 8px;
}
</style>
