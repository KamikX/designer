<script setup lang="ts">
import { App, theme } from 'antdv-next'
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ImportOutlined,
  LinkOutlined,
  PlusOutlined
} from '@antdv-next/icons'
import type { InstalledSkill, MarketMcp, MarketSkill, McpServerView } from '@shared/types'

/**
 * 技能与 MCP 中心。
 *
 * 技能和 MCP 的事实来源都在文件系统(技能是目录,MCP 是 mcp.json),这页
 * 只是它们的可视化入口:装、删、启停,以及跳去编辑。市场清单来自设置里
 * 配置的远程市场源(marketUrl):没配就是空的,页面上引导去设置;拉取失败
 * 会给一条人话提示,不会炸页面。
 *
 * ## MCP 的安装确认不是走过场
 *
 * stdio 类的 MCP 本质是**在用户机器上起一个进程**(基本都是 `npx -y 某个包`)。
 * 一个写着"安装"的按钮会让人以为这和装个插件一样安全,而它实际能做的事和
 * 用户自己在终端里敲那条命令完全一样。
 *
 * 所以确认框里**原样展示完整命令**,并说清进程以谁的身份运行。让用户自己
 * 判断,而不是替他判断。
 */

const { token } = theme.useToken()
const { message, modal } = App.useApp()
const router = useRouter()

const pane = ref<'skills' | 'mcp'>('skills')
const PANES = [
  { label: '技能', value: 'skills' },
  { label: 'MCP', value: 'mcp' }
]

const marketSkills = ref<MarketSkill[]>([])
const marketMcp = ref<MarketMcp[]>([])
const installed = ref<InstalledSkill[]>([])
const servers = ref<McpServerView[]>([])
const mcpProblem = ref<string | undefined>()
/** 市场源状态:没配地址 → 引导去设置;拉取失败 → 展示原因 */
const marketSource = ref<{ url: string; problem?: string }>({ url: '' })

async function reload(): Promise<void> {
  const [ms, mm, is, mcp, source] = await Promise.all([
    window.api.market.skills(),
    window.api.market.mcp(),
    window.api.market.installedSkills(),
    window.api.mcp.list(),
    window.api.market.status()
  ])
  marketSkills.value = ms
  marketMcp.value = mm
  installed.value = is
  servers.value = mcp.servers
  mcpProblem.value = mcp.problem
  marketSource.value = source
}
onMounted(reload)

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ */
/* 技能                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按来源分三块。用户需要知道一个技能**装在哪** —— 全局那份是跨工具共享的,
 * 改它会影响 Claude Code、Codex 里的使用;只有「我的技能」(app)可编辑可删,
 * 主进程的文件操作也只 scoped 在那个目录下。
 */
const mySkills = computed(() => installed.value.filter((s) => s.source === 'app'))
const builtinSkills = computed(() => installed.value.filter((s) => s.source === 'builtin'))
const globalSkills = computed(() =>
  installed.value.filter((s) => s.source === 'agents' || s.source === 'claude')
)

/*
 * 按名字判断装没装。技能的身份就是目录名,市场条目也没有"装到了哪"的
 * 回链——同名即视为已装,用户删掉重装一次也不会有什么损失。
 */
const skillInstalled = (s: MarketSkill): boolean => installed.value.some((x) => x.name === s.name)
const mcpInstalled = (m: MarketMcp): boolean => servers.value.some((x) => x.name === m.name)

const createOpen = ref(false)
const createName = ref('')
const creating = ref(false)

async function submitCreate(): Promise<void> {
  const name = createName.value.trim()
  if (!name) {
    message.warning('请输入技能名字(会成为目录名)')
    return
  }
  creating.value = true
  try {
    const skill = await window.api.skill.create(name)
    createOpen.value = false
    createName.value = ''
    // 建完直接进编辑器:新技能只有一份模板 SKILL.md,留在列表页没有下一步
    router.push({ name: 'SkillEditor', params: { name: skill.name } })
  } catch (err) {
    message.error(errText(err))
  } finally {
    creating.value = false
  }
}

async function importZip(): Promise<void> {
  try {
    const skill = await window.api.skill.importPackage()
    if (!skill) return // 用户在文件框里取消了,不是错误
    await reload()
    message.success(`已导入「${skill.name}」`)
  } catch (err) {
    message.error(errText(err))
  }
}

function editSkill(s: InstalledSkill): void {
  router.push({ name: 'SkillEditor', params: { name: s.name } })
}

function removeSkill(s: InstalledSkill): void {
  modal.confirm({
    title: `删除「${s.name}」?`,
    content: '整个技能目录会被删除,不可恢复。',
    okText: '删除',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      await window.api.skill.remove(s.name)
      await reload()
    }
  })
}

async function installSkill(s: MarketSkill): Promise<void> {
  try {
    await window.api.skill.installMarket(s.id)
    await reload()
    message.success(`已安装「${s.name}」,可以在输入框的技能里勾选`)
  } catch (err) {
    message.error(errText(err))
  }
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

/** 卡片上的一句话摘要:stdio 露命令,远程的露端点 */
function mcpSummary(s: McpServerView): string {
  return s.transport === 'stdio' ? [s.command, ...s.args].filter(Boolean).join(' ') : (s.url ?? '')
}

async function toggleMcp(s: McpServerView, enabled: boolean): Promise<void> {
  try {
    await window.api.mcp.setEnabled(s.name, enabled)
  } catch (err) {
    message.error(errText(err))
  }
  // 成败都重读一遍:开关的真实状态在 mcp.json 里,界面别自己猜
  await reload()
}

function removeMcp(s: McpServerView): void {
  modal.confirm({
    title: `删除「${s.name}」?`,
    content: '会从 mcp.json 里移除这条配置。',
    okText: '删除',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      await window.api.mcp.remove(s.name)
      await reload()
    }
  })
}

const jsonOpen = ref(false)
const jsonText = ref('')
const importingJson = ref(false)

async function submitImportJson(): Promise<void> {
  if (!jsonText.value.trim()) {
    message.warning('请粘贴 JSON 配置')
    return
  }
  importingJson.value = true
  try {
    const imported = await window.api.mcp.importJson(jsonText.value)
    jsonOpen.value = false
    jsonText.value = ''
    await reload()
    message.success(`已导入 ${imported.length} 个 MCP 服务`)
  } catch (err) {
    // importJson 抛出来的 message 是主进程写好的人话,原样给用户
    message.error(errText(err))
  } finally {
    importingJson.value = false
  }
}

function installMcp(m: MarketMcp): void {
  const command = [m.command, ...(m.args ?? [])].join(' ')

  modal.confirm({
    title: `安装「${m.name}」?`,
    width: 520,
    okText: '我知道,安装',
    cancelText: '取消',
    content: h('div', { style: 'font-size:13px;line-height:1.8' }, [
      h('p', { style: 'margin:0 0 8px' }, '它会在你的机器上执行:'),
      h(
        'pre',
        {
          style: `margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:12px;
                  white-space:pre-wrap;word-break:break-all;background:${token.value.colorFillQuaternary}`
        },
        command
      ),
      h(
        'p',
        { style: `margin:0;color:${token.value.colorTextTertiary}` },
        '首次运行会从 npm 下载。进程以你的身份运行,能做的事和你在终端里一样。'
      ),
      ...(m.envHints?.length
        ? [
            h(
              'p',
              { style: `margin:8px 0 0;color:${token.value.colorTextTertiary}` },
              `装好后还需要补环境变量:${m.envHints.map((e) => e.key).join('、')}`
            )
          ]
        : [])
    ]),
    onOk: async () => {
      await window.api.mcp.upsert(m.name, {
        transport: m.transport,
        ...(m.command ? { command: m.command } : {}),
        ...(m.args ? { args: m.args } : {}),
        ...(m.url ? { url: m.url } : {})
      })
      await reload()
      message.success(`已安装「${m.name}」`)
    }
  })
}
</script>

<template>
  <div class="market">
    <div class="market-head">
      <div class="market-title">技能与 MCP</div>
      <div class="market-sub" :style="{ color: token.colorTextTertiary }">
        技能是文件目录,MCP 是 mcp.json。市场清单来自你配置的市场源
      </div>
    </div>

    <a-alert
      v-if="marketSource.problem"
      type="warning"
      show-icon
      :message="marketSource.problem"
      style="margin-bottom: 12px"
    />

    <a-segmented v-model:value="pane" :options="PANES" />

    <!-- ============================== 技能 ============================== -->
    <template v-if="pane === 'skills'">
      <div class="market-actions">
        <a-button type="primary" @click="createOpen = true">
          <template #icon><PlusOutlined /></template>
          新建技能
        </a-button>
        <a-button @click="importZip">
          <template #icon><ImportOutlined /></template>
          导入 zip
        </a-button>
      </div>

      <div v-if="mySkills.length" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">我的技能</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            ~/.antd-designer/skills · 可编辑,只在本应用生效
          </span>
        </div>
        <div class="market-grid">
          <div
            v-for="s in mySkills"
            :key="s.dir"
            class="market-card"
            :style="{ borderColor: token.colorBorderSecondary }"
          >
            <div class="market-card-head">
              <span class="market-card-name">{{ s.name }}</span>
              <a-tag v-if="s.warning" color="warning">格式问题</a-tag>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div v-if="s.warning" class="market-card-warn" :style="{ color: token.colorWarning }">
              {{ s.warning }}
            </div>
            <div class="market-card-ops">
              <a-button size="small" @click="editSkill(s)">
                <template #icon><EditOutlined /></template>
                编辑
              </a-button>
              <a-button size="small" danger @click="removeSkill(s)">
                <template #icon><DeleteOutlined /></template>
                删除
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="builtinSkills.length" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">内置技能</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            随应用发布 · 设计会话按项目勾选的端自动生效
          </span>
        </div>
        <div class="market-grid">
          <div
            v-for="s in builtinSkills"
            :key="s.dir"
            class="market-card"
            :style="{ borderColor: token.colorBorderSecondary }"
          >
            <div class="market-card-head">
              <span class="market-card-name">{{ s.name }}</span>
              <a-tag v-if="s.warning" color="warning">格式问题</a-tag>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div v-if="s.warning" class="market-card-warn" :style="{ color: token.colorWarning }">
              {{ s.warning }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="globalSkills.length" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">全局技能</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            ~/.agents/skills、~/.claude/skills · 跨 AI 工具共享,这里只读
          </span>
        </div>
        <div class="market-grid">
          <div
            v-for="s in globalSkills"
            :key="s.dir"
            class="market-card"
            :style="{ borderColor: token.colorBorderSecondary }"
          >
            <div class="market-card-head">
              <span class="market-card-name">{{ s.name }}</span>
              <a-tag v-if="s.warning" color="warning">格式问题</a-tag>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div v-if="s.warning" class="market-card-warn" :style="{ color: token.colorWarning }">
              {{ s.warning }}
            </div>
          </div>
        </div>
      </div>

      <div class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">技能市场</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            安装到「我的技能」,装完可编辑
          </span>
        </div>
        <a-empty
          v-if="!marketSource.url"
          description="还没有配置市场源"
          :image-style="{ height: '48px' }"
        >
          <a-button size="small" @click="router.push('/settings')">去设置里填市场地址</a-button>
        </a-empty>
        <a-empty
          v-else-if="marketSkills.length === 0"
          description="市场源里没有技能"
          :image-style="{ height: '48px' }"
        />
        <div v-else class="market-grid">
          <div
            v-for="s in marketSkills"
            :key="s.id"
            class="market-card"
            :style="{ borderColor: token.colorBorderSecondary }"
          >
            <div class="market-card-head">
              <span class="market-card-name">{{ s.name }}</span>
              <a-button
                size="small"
                :type="skillInstalled(s) ? 'default' : 'primary'"
                :disabled="skillInstalled(s)"
                @click="installSkill(s)"
              >
                <template v-if="skillInstalled(s)" #icon><CheckOutlined /></template>
                {{ skillInstalled(s) ? '已安装' : '安装' }}
              </a-button>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div class="market-card-tags">
              <a-tag v-for="t in s.tags" :key="t">{{ t }}</a-tag>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============================== MCP =============================== -->
    <template v-else>
      <a-alert
        v-if="mcpProblem"
        type="warning"
        show-icon
        :message="mcpProblem"
        style="margin-top: 12px"
      />

      <div class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">我的 MCP</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            ~/.antd-designer/mcp.json · 勾选的会话才连接
          </span>
          <a-button size="small" style="margin-left: auto" @click="jsonOpen = true">
            <template #icon><ImportOutlined /></template>
            从 JSON 导入
          </a-button>
        </div>
        <a-empty
          v-if="servers.length === 0"
          description="还没有 MCP 服务。从下面的市场安装,或粘贴 JSON 导入"
          style="margin: 24px 0"
        />
        <div v-else class="market-grid">
          <div
            v-for="s in servers"
            :key="s.name"
            class="market-card"
            :style="{ borderColor: token.colorBorderSecondary }"
          >
            <div class="market-card-head">
              <span class="market-card-name">{{ s.name }}</span>
              <a-switch
                size="small"
                :checked="s.enabled"
                @change="(v: unknown) => toggleMcp(s, Boolean(v))"
              />
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              <a-tag>{{ s.transport }}</a-tag>
            </div>
            <code
              v-if="mcpSummary(s)"
              class="market-card-cmd"
              :style="{ background: token.colorFillQuaternary }"
            >
              {{ mcpSummary(s) }}
            </code>
            <div
              v-if="s.missingEnv?.length"
              class="market-card-warn"
              :style="{ color: token.colorWarning }"
            >
              缺环境变量 {{ s.missingEnv.join('、') }}
            </div>
            <div class="market-card-ops">
              <a-button size="small" danger @click="removeMcp(s)">
                <template #icon><DeleteOutlined /></template>
                删除
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <div class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">MCP 市场</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            安装前会原样展示要执行的命令
          </span>
        </div>
        <a-empty
          v-if="!marketSource.url"
          description="还没有配置市场源"
          :image-style="{ height: '48px' }"
        >
          <a-button size="small" @click="router.push('/settings')">去设置里填市场地址</a-button>
        </a-empty>
        <a-empty
          v-else-if="marketMcp.length === 0"
          description="市场源里没有 MCP 服务"
          :image-style="{ height: '48px' }"
        />
        <div v-else class="market-grid">
          <div
            v-for="m in marketMcp"
            :key="m.id"
            class="market-card"
            :style="{ borderColor: token.colorBorderSecondary }"
          >
            <div class="market-card-head">
              <span class="market-card-name">{{ m.name }}</span>
              <a-button
                size="small"
                :type="mcpInstalled(m) ? 'default' : 'primary'"
                :disabled="mcpInstalled(m)"
                @click="installMcp(m)"
              >
                <template v-if="mcpInstalled(m)" #icon><CheckOutlined /></template>
                {{ mcpInstalled(m) ? '已安装' : '安装' }}
              </a-button>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ m.description }}
            </div>
            <!-- 命令在卡片上就露出来,不用点开确认框才知道它要跑什么 -->
            <code class="market-card-cmd" :style="{ background: token.colorFillQuaternary }">
              {{ [m.command, ...(m.args ?? [])].join(' ') }}
            </code>
            <div class="market-card-tags">
              <a-tag v-for="t in m.tags" :key="t">{{ t }}</a-tag>
              <a v-if="m.homepage" :href="m.homepage" target="_blank" class="market-card-link">
                <LinkOutlined /> 主页
              </a>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建技能:只要一个名字。名字就是目录名,也是技能的身份 -->
    <a-modal
      v-model:open="createOpen"
      title="新建技能"
      :confirm-loading="creating"
      ok-text="创建并编辑"
      @ok="submitCreate"
    >
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item label="技能名字(会成为目录名)" required>
          <a-input
            v-model:value="createName"
            placeholder="如 my-design-rules"
            @press-enter="submitCreate"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 从 JSON 导入 MCP:兼容各家工具的 mcpServers 方言,解析在主进程做 -->
    <a-modal
      v-model:open="jsonOpen"
      title="从 JSON 导入 MCP"
      :confirm-loading="importingJson"
      :width="560"
      ok-text="导入"
      @ok="submitImportJson"
    >
      <a-textarea
        v-model:value="jsonText"
        :rows="10"
        style="margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace"
        placeholder='支持 Claude Desktop / Cursor / VS Code 的 mcpServers JSON,如:
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  }
}'
      />
    </a-modal>
  </div>
</template>

<style scoped>
.market {
  padding: 0 var(--page-pad) var(--page-pad);
}

.market-head {
  margin-bottom: 12px;
}

.market-title {
  font-size: 20px;
  font-weight: 700;
}

.market-sub {
  margin-top: 4px;
  font-size: 12px;
}

.market-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 4px;
}

.market-group {
  margin-top: 14px;
}

.market-group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.market-group-title {
  font-size: 13px;
  font-weight: 600;
}

.market-group-hint {
  font-size: 11px;
}

.market-card-warn {
  font-size: 11px;
  margin-top: 6px;
}

.market-card {
  border: 1px solid;
  border-radius: 12px;
  padding: 14px;
}

.market-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.market-card-name {
  font-size: 14px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-card-desc {
  font-size: 12px;
  line-height: 1.7;
  min-height: 40px;
}

.market-card-cmd {
  display: block;
  margin: 8px 0;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11px;
  word-break: break-all;
}

.market-card-tags {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.market-card-ops {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.market-card-link {
  font-size: 11px;
  margin-left: auto;
}
</style>
