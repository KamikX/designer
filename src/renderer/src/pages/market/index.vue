<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { ApiOutlined, BulbOutlined, CheckOutlined, LinkOutlined } from '@antdv-next/icons'
import type { InstalledSkill, MarketMcp, MarketSkill, McpServer, Skill } from '@shared/types'

/**
 * 技能 / MCP 市场。
 *
 * 清单目前内置在主进程里,跟着版本发,零网络依赖。
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

const tab = ref<'installed' | 'skills' | 'mcp'>('installed')

const marketSkills = ref<MarketSkill[]>([])
const marketMcp = ref<MarketMcp[]>([])
const installedSkills = ref<Skill[]>([])
const fileSkills = ref<InstalledSkill[]>([])

/**
 * 按来源分组。用户需要知道一个技能**装在哪** —— 全局那份是跨工具共享的,
 * 改它会影响 Claude Code、Codex 里的使用;本应用那份只影响这里。
 */
const SOURCE_LABEL: Record<InstalledSkill['source'], { title: string; hint: string }> = {
  builtin: { title: '内置', hint: '随应用发布 · 手艺规则与设计种子' },
  app: { title: '本应用', hint: '~/.antd-designer/skills · 只在这里生效' },
  agents: { title: '全局', hint: '~/.agents/skills · 其他 AI 工具共享' },
  claude: { title: 'Claude', hint: '~/.claude/skills · 兼容位置' }
}
const grouped = computed(() =>
  (['builtin', 'app', 'agents', 'claude'] as const)
    .map((source) => ({
      source,
      ...SOURCE_LABEL[source],
      items: fileSkills.value.filter((s) => s.source === source)
    }))
    .filter((g) => g.items.length)
)
const installedMcp = ref<McpServer[]>([])

async function reload(): Promise<void> {
  const [ms, mm, is, im, fs] = await Promise.all([
    window.api.market.skills(),
    window.api.market.mcp(),
    window.api.skill.list(),
    window.api.mcp.list(),
    window.api.market.installedSkills()
  ])
  marketSkills.value = ms
  marketMcp.value = mm
  installedSkills.value = is
  installedMcp.value = im
  fileSkills.value = fs
}
onMounted(reload)

/*
 * 按名字判断装没装。
 *
 * 本地表里没有"来自市场哪一条"的字段,加一列要开迁移,而这个判断只用来控制
 * 按钮是否置灰——用户改了名就当没装过,重装一次也不会有什么损失。等真需要
 * 做"更新到新版本"时再加那一列。
 */
const skillInstalled = (s: MarketSkill): boolean =>
  installedSkills.value.some((x) => x.name === s.name)
const mcpInstalled = (m: MarketMcp): boolean => installedMcp.value.some((x) => x.name === m.name)

async function installSkill(s: MarketSkill): Promise<void> {
  await window.api.skill.create({ name: s.name, description: s.description, content: s.content })
  await reload()
  message.success(`已安装「${s.name}」,可以在输入框的技能里勾选`)
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
              `装好后还需要在设置里补:${m.envHints.map((e) => e.key).join('、')}`
            )
          ]
        : [])
    ]),
    onOk: async () => {
      await window.api.mcp.create({
        name: m.name,
        transport: m.transport,
        ...(m.command ? { command: m.command } : {}),
        ...(m.args ? { args: m.args } : {}),
        ...(m.url ? { url: m.url } : {})
      })
      await reload()
      message.success(`已安装「${m.name}」,到设置里可以调整参数`)
    }
  })
}
</script>

<template>
  <div class="market">
    <div class="market-head">
      <div class="market-title">市场</div>
      <div class="market-sub" :style="{ color: token.colorTextTertiary }">
        安装现成的技能和 MCP 服务。清单随应用版本更新,不联网
      </div>
    </div>

    <a-tabs v-model:active-key="tab" size="small">
      <a-tab-pane key="installed">
        <template #tab><CheckOutlined /> 已装技能 ({{ fileSkills.length }})</template>
      </a-tab-pane>
      <a-tab-pane key="skills">
        <template #tab><BulbOutlined /> 技能</template>
      </a-tab-pane>
      <a-tab-pane key="mcp">
        <template #tab><ApiOutlined /> MCP 服务</template>
      </a-tab-pane>
    </a-tabs>

    <!-- 已装:按来源分组,标明位置 -->
    <template v-if="tab === 'installed'">
      <a-empty
        v-if="fileSkills.length === 0"
        description="还没有扫到技能。放到 ~/.agents/skills 或 ~/.antd-designer/skills 下即可"
        style="margin-top: 60px"
      />
      <div v-for="group in grouped" :key="group.source" class="market-group">
        <div class="market-group-head">
          <span class="market-group-title">{{ group.title }}</span>
          <span class="market-group-hint" :style="{ color: token.colorTextTertiary }">
            {{ group.hint }}
          </span>
        </div>
        <div class="market-grid">
          <div
            v-for="s in group.items"
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
    </template>

    <div v-else class="market-grid">
      <template v-if="tab === 'skills'">
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
      </template>

      <template v-else>
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
      </template>
    </div>
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

.market-card-link {
  font-size: 11px;
  margin-left: auto;
}
</style>
