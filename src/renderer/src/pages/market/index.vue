<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
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
  {
    get label() {
      return t('common.skills')
    },
    value: 'skills'
  },
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
  return uiMessage(err instanceof Error ? err.message : String(err))
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
// builtin-* 领域技能包也算随应用发布的,归进同一个内置区展示
const builtinSkills = computed(() =>
  installed.value.filter((s) => s.source === 'builtin' || s.source.startsWith('builtin-'))
)
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
    message.warning(t('messages.enterASkillNameUsedAsItsDirectoryName'))
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
    message.success(t('common.imported', skill.name))
  } catch (err) {
    message.error(errText(err))
  }
}

function editSkill(s: InstalledSkill): void {
  router.push({ name: 'SkillEditor', params: { name: s.name } })
}

function removeSkill(s: InstalledSkill): void {
  modal.confirm({
    get title() {
      return t('common.delete', s.name)
    },
    content: t('messages.theEntireSkillDirectoryWillBePermanentlyDeleted'),
    okText: t('common.deleteLabel'),
    okButtonProps: { danger: true },
    cancelText: t('common.cancel'),
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
    message.success(t('messages.installedSelectItInTheComposerSSkillsMenuToUseIt', s.name))
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
    get title() {
      return t('common.delete', s.name)
    },
    content: t('messages.thisConfigurationWillBeRemovedFromMcpJson'),
    okText: t('common.deleteLabel'),
    okButtonProps: { danger: true },
    cancelText: t('common.cancel'),
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
    message.warning(t('messages.pasteAJsonConfiguration'))
    return
  }
  importingJson.value = true
  try {
    const imported = await window.api.mcp.importJson(jsonText.value)
    jsonOpen.value = false
    jsonText.value = ''
    await reload()
    message.success(t('messages.importedMcpServices', imported.length))
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
    get title() {
      return t('common.install', m.name)
    },
    width: 520,
    okText: t('common.installLabel'),
    cancelText: t('common.cancel'),
    content: h('div', { style: 'font-size:13px;line-height:1.8' }, [
      h('p', { style: 'margin:0 0 8px' }, t('messages.itWillRunTheFollowingCommandOnYourMachine')),
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
        t('messages.theFirstRunDownloadsFromNpm')
      ),
      ...(m.envHints?.length
        ? [
            h(
              'p',
              { style: `margin:8px 0 0;color:${token.value.colorTextTertiary}` },
              t(
                'messages.afterInstallationConfigureTheseEnvironmentVariables',
                m.envHints.map((e) => e.key).join('、')
              )
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
      message.success(t('common.installed', m.name))
    }
  })
}
</script>

<template>
  <div class="market">
    <div class="market-head">
      <div class="market-title">{{ t('common.skillsAndMcp') }}</div>
      <div class="market-sub" :style="{ color: token.colorTextTertiary }">
        {{ t('messages.skillsAreFileDirectoriesMcpUses') }}
      </div>
    </div>

    <a-alert
      v-if="marketSource.problem"
      type="warning"
      show-icon
      :message="uiMessage(marketSource.problem)"
      style="margin-bottom: 12px"
    />

    <a-segmented v-model:value="pane" :options="PANES" />

    <!-- ============================== 技能 ============================== -->
    <template v-if="pane === 'skills'">
      <div class="market-actions">
        <a-button type="primary" @click="createOpen = true">
          <template #icon><PlusOutlined /></template>
          {{ t('common.newSkill') }}
        </a-button>
        <a-button @click="importZip">
          <template #icon><ImportOutlined /></template>
          {{ t('common.importZip') }}
        </a-button>
      </div>

      <div v-if="mySkills.length" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ t('common.mySkills') }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.antdDesignerSkillsEditableAvailableOnlyInThisApplication') }}
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
              <a-tag v-if="s.warning" color="warning">{{ t('common.formatIssue') }}</a-tag>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div v-if="s.warning" class="market-card-warn" :style="{ color: token.colorWarning }">
              {{ s.warning.split(';').map(uiMessage).join('; ') }}
            </div>
            <div class="market-card-ops">
              <a-button size="small" @click="editSkill(s)">
                <template #icon><EditOutlined /></template>
                {{ t('common.edit') }}
              </a-button>
              <a-button size="small" danger @click="removeSkill(s)">
                <template #icon><DeleteOutlined /></template>
                {{ t('common.deleteLabel') }}
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="builtinSkills.length" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ t('common.builtInSkills') }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.bundledWithTheApplicationEnabledFor') }}
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
              <a-tag v-if="s.warning" color="warning">{{ t('common.formatIssue') }}</a-tag>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div v-if="s.warning" class="market-card-warn" :style="{ color: token.colorWarning }">
              {{ s.warning.split(';').map(uiMessage).join('; ') }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="globalSkills.length" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ t('common.globalSkills') }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.agentsSkillsClaudeSkillsSharedAcrossAiToolsReadOnlyHere') }}
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
              <a-tag v-if="s.warning" color="warning">{{ t('common.formatIssue') }}</a-tag>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div v-if="s.warning" class="market-card-warn" :style="{ color: token.colorWarning }">
              {{ s.warning.split(';').map(uiMessage).join('; ') }}
            </div>
          </div>
        </div>
      </div>

      <div class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ t('common.skillMarketplace') }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.installToMySkillsEditableAfterInstallation') }}
          </span>
        </div>
        <a-empty
          v-if="!marketSource.url"
          :description="t('messages.noMarketplaceSourceConfigured')"
          :image-style="{ height: '48px' }"
        >
          <a-button size="small" @click="router.push('/settings')">{{
            t('messages.setTheMarketplaceUrlInSettings')
          }}</a-button>
        </a-empty>
        <a-empty
          v-else-if="marketSkills.length === 0"
          :description="t('messages.noSkillsInThisMarketplace')"
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
                {{ skillInstalled(s) ? t('common.installedLabel') : t('common.installLabelText') }}
              </a-button>
            </div>
            <div class="market-card-desc" :style="{ color: token.colorTextSecondary }">
              {{ s.description }}
            </div>
            <div class="market-card-tags">
              <a-tag v-for="tag in s.tags" :key="tag">{{ tag }}</a-tag>
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
        :message="uiMessage(mcpProblem)"
        style="margin-top: 12px"
      />

      <div class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ t('common.myMcpServices') }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.antdDesignerMcpJsonConnectedOnlyInSessionsWhereSelected') }}
          </span>
          <a-button size="small" style="margin-left: auto" @click="jsonOpen = true">
            <template #icon><ImportOutlined /></template>
            {{ t('common.importJson') }}
          </a-button>
        </div>
        <a-empty
          v-if="servers.length === 0"
          :description="t('messages.noMcpServicesYetInstallFromTheMarketplaceBelowOrImportJson')"
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
              {{ t('common.missingEnvironmentVariables') }} {{ s.missingEnv.join('、') }}
            </div>
            <div class="market-card-ops">
              <a-button size="small" danger @click="removeMcp(s)">
                <template #icon><DeleteOutlined /></template>
                {{ t('common.deleteLabel') }}
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <div class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ t('common.mcpMarketplace') }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.theExactCommandIsShownBeforeInstallation') }}
          </span>
        </div>
        <a-empty
          v-if="!marketSource.url"
          :description="t('messages.noMarketplaceSourceConfigured')"
          :image-style="{ height: '48px' }"
        >
          <a-button size="small" @click="router.push('/settings')">{{
            t('messages.setTheMarketplaceUrlInSettings')
          }}</a-button>
        </a-empty>
        <a-empty
          v-else-if="marketMcp.length === 0"
          :description="t('messages.noMcpServicesInThisMarketplace')"
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
                {{ mcpInstalled(m) ? t('common.installedLabel') : t('common.installLabelText') }}
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
              <a-tag v-for="tag in m.tags" :key="tag">{{ tag }}</a-tag>
              <a v-if="m.homepage" :href="m.homepage" target="_blank" class="market-card-link">
                <LinkOutlined /> {{ t('common.website') }}
              </a>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建技能:只要一个名字。名字就是目录名,也是技能的身份 -->
    <a-modal
      v-model:open="createOpen"
      :title="t('common.newSkill')"
      :confirm-loading="creating"
      :ok-text="t('common.createAndEdit')"
      @ok="submitCreate"
    >
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item :label="t('messages.skillNameUsedAsItsDirectoryName')" required>
          <a-input
            v-model:value="createName"
            :placeholder="t('common.eGMyDesignRules')"
            @press-enter="submitCreate"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 从 JSON 导入 MCP:兼容各家工具的 mcpServers 方言,解析在主进程做 -->
    <a-modal
      v-model:open="jsonOpen"
      :title="t('messages.importMcpFromJson')"
      :confirm-loading="importingJson"
      :width="560"
      :ok-text="t('common.import')"
      @ok="submitImportJson"
    >
      <a-textarea
        v-model:value="jsonText"
        :rows="10"
        style="margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace"
        :placeholder="t('messages.supportsClaudeDesktopCursorVsCode')"
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
