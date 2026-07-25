<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { useCollabStore } from '@renderer/stores/collab'
import RoleAvatar from './RoleAvatar.vue'
import type { Conversation } from '@shared/types'

/**
 * 新建群组:群名 + 角色多选卡片。
 *
 * 默认全选五个角色——它们是一条完整的接力流水线,少了谁链条都可能在
 * 那一环断掉。用户明确知道自己不需要哪个环节时再取消。
 */

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [group: Conversation] }>()

const { token } = theme.useToken()
const { message } = App.useApp()
const collab = useCollabStore()

const name = ref('')
const picked = ref<string[]>([])
const creating = ref(false)

// 每次打开都重置成默认态,上一次建群的残留不该带过来
watch(open, (now) => {
  if (!now) return
  name.value = ''
  picked.value = collab.roles.map((r) => r.id)
})

function toggle(id: string): void {
  picked.value = picked.value.includes(id)
    ? picked.value.filter((x) => x !== id)
    : [...picked.value, id]
}

async function submit(): Promise<void> {
  const groupName = name.value.trim()
  if (!groupName) {
    message.warning('给群组起个名字')
    return
  }
  if (picked.value.length === 0) {
    message.warning('至少选择一个角色')
    return
  }
  creating.value = true
  try {
    // 摊成普通数组:IPC 是 structured clone,响应式代理传不过去
    const created = await collab.createGroup(groupName, [...picked.value])
    open.value = false
    emit('created', created)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    title="新建群组"
    :confirm-loading="creating"
    :width="520"
    centered
    ok-text="建群"
    @ok="submit"
  >
    <!-- 角色多起来时整体可能超过视口:内容封顶,内部滚 -->
    <div class="create-body">
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item label="群组名称" required>
          <a-input
            v-model:value="name"
            size="large"
            placeholder="如 官网改版专项 / 管理后台需求评审"
            @press-enter="submit"
          />
        </a-form-item>

        <a-form-item label="成员角色">
          <div class="role-grid">
            <button
              v-for="role in collab.roles"
              :key="role.id"
              type="button"
              class="role-card"
              :style="
                picked.includes(role.id)
                  ? { borderColor: role.color, boxShadow: `0 0 0 1px ${role.color}` }
                  : { borderColor: token.colorBorderSecondary }
              "
              @click="toggle(role.id)"
            >
              <RoleAvatar :role="role" :size="24" />
              <span class="role-card-name">{{ role.name }}</span>
              <span class="role-card-duty" :style="{ color: token.colorTextTertiary }">
                {{ role.duty }}
              </span>
            </button>
          </div>
        </a-form-item>
      </a-form>
    </div>
  </a-modal>
</template>

<style scoped>
.create-body {
  max-height: 70vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
}

.role-card {
  display: grid;
  grid-template-columns: 24px 1fr;
  grid-template-areas: 'avatar name' 'avatar duty';
  gap: 2px 10px;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 10px;
  background: none;
  cursor: pointer;
  color: inherit;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.role-card > :first-child {
  grid-area: avatar;
  align-self: center;
}

.role-card-name {
  grid-area: name;
  font-size: 13px;
  font-weight: 500;
}

.role-card-duty {
  grid-area: duty;
  font-size: 11px;
  line-height: 1.5;
}
</style>
