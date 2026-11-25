import { text as appText } from '../i18n'
/**
 * 工具调用的人话标签。
 *
 * 工具协议下模型在调工具的那几十秒里根本不产文字,聊天框一片死寂。这个
 * 模块把 `read_file` + `{path, start_line}` 变成「读取 index.html 1-80 行」,
 * 让那段时间有东西可看。
 *
 * ## 为什么在主进程算,而不是把入参推给渲染层
 *
 * `write_file` 的入参里是整份文件内容,`apply_patch` 的入参是整个补丁。
 * 推过去既没用又贵,还得在渲染层再写一遍裁剪逻辑。主进程算好一句短句
 * 发出去,IPC 上跑的永远是几十个字符。
 *
 * ## 入参是流式到达的
 *
 * 模型吐工具入参是逐字的,`path` 通常最先出现(字段顺序跟 schema 走)。
 * 所以这里对**半截 JSON** 也要能出标签——早一秒告诉用户"在写
 * index.html",体验差别很大。解析不出来就退回工具的通用动词。
 */

/** 每个工具的通用动词:入参还没到齐时先用它 */
const VERB: Record<string, string> = {
  get list_files() {
    return appText('common.listFiles')
  },
  get outline_file() {
    return appText('common.viewStructure')
  },
  get read_file() {
    return appText('common.read')
  },
  get get_range() {
    return appText('common.getSourceText')
  },
  get capture_range() {
    return appText('common.captureAnchor')
  },
  get apply_string_edits() {
    return appText('common.editAnchors')
  },
  get search_files() {
    return appText('common.search')
  },
  get edit_file() {
    return appText('common.edit')
  },
  get multi_edit_file() {
    return appText('common.batchEdit')
  },
  get apply_patch() {
    return appText('common.applyPatch')
  },
  get write_file() {
    return appText('common.write')
  },
  get move_file() {
    return appText('common.move')
  },
  get copy_file() {
    return appText('common.copy')
  },
  get delete_file() {
    return appText('common.deleteLabel')
  },
  get diff_changes() {
    return appText('messages.viewChangesFromThisTurn')
  },
  get check_syntax() {
    return appText('common.checkStructure')
  },
  get revert_file() {
    return appText('common.revertChanges')
  },
  get set_style_brief() {
    return appText('common.updateVisualDirection')
  },
  get ask_user() {
    return appText('messages.askYouAQuestion')
  },
  get view_image() {
    return appText('common.viewReferenceImage')
  },
  get note_image() {
    return appText('messages.recordReferenceImageNotes')
  },
  get get_current_time() {
    return appText('common.getCurrentTime')
  },
  get activate_skill() {
    return appText('common.loadSkill')
  },
  get install_skill() {
    return appText('common.installSkill')
  },
  get install_mcp() {
    return appText('common.installMcpService')
  },
  // 本地文件
  get list_local_dir() {
    return appText('common.browseDirectory')
  },
  get check_local_path() {
    return appText('common.checkPath')
  },
  get find_local_files() {
    return appText('common.findFiles')
  },
  get search_local() {
    return appText('common.searchLocalFiles')
  },
  get read_local_file() {
    return appText('common.readLocalFile')
  },
  get read_local_document() {
    return appText('common.parseDocument')
  },
  get read_document_images() {
    return appText('common.viewDocumentImages')
  },
  // 联网
  get web_search() {
    return appText('common.searchWeb')
  },
  get web_fetch() {
    return appText('common.openWebPage')
  },
  get browser_open() {
    return appText('common.openWebPage')
  },
  get browser_snapshot() {
    return appText('common.inspectPage')
  },
  get browser_click() {
    return appText('common.click')
  },
  get browser_fill_form() {
    return appText('common.fillForm')
  },
  get browser_press_key() {
    return appText('common.pressKey')
  },
  get browser_scroll() {
    return appText('common.scrollPage')
  }
}

export function verbOf(toolName: string): string {
  return VERB[toolName] ?? toolName
}

/**
 * 编辑族工具的相位动词。
 *
 * tool-input-start 到 tool-call 之间是**模型在生成参数**,不是本地在执行。
 * 之前这段时间就显示"应用补丁",用户把模型生成参数的几十秒都记在了本地
 * 补丁引擎头上。preparing 阶段必须说"准备",onToolExecutionStart 之后
 * 才允许说"执行"。
 */
const PREPARING_VERB: Record<string, string> = {
  get apply_patch() {
    return appText('common.preparePatch')
  },
  get edit_file() {
    return appText('common.prepareEdit')
  },
  get multi_edit_file() {
    return appText('common.prepareEdit')
  },
  get apply_string_edits() {
    return appText('common.prepareEdit')
  },
  get write_file() {
    return appText('common.prepareWrite')
  }
}

const EXECUTING_VERB: Record<string, string> = {
  get apply_patch() {
    return appText('common.executePatch')
  },
  get edit_file() {
    return appText('common.executeEdit')
  },
  get multi_edit_file() {
    return appText('common.executeEdit')
  },
  get apply_string_edits() {
    return appText('common.executeEdit')
  },
  get write_file() {
    return appText('common.executeWrite')
  }
}

/** 把「动词 目标」换相位动词;已带任一相位动词的也能换。非编辑族原样返回 */
function swapVerb(toolName: string, label: string, table: Record<string, string>): string {
  const phased = table[toolName]
  if (!phased) return label
  for (const prefix of [verbOf(toolName), PREPARING_VERB[toolName], EXECUTING_VERB[toolName]]) {
    if (prefix && label.startsWith(prefix)) return phased + label.slice(prefix.length)
  }
  return phased
}

export function preparingLabel(toolName: string, label: string): string {
  return swapVerb(toolName, label, PREPARING_VERB)
}

export function executingLabel(toolName: string, label: string): string {
  return swapVerb(toolName, label, EXECUTING_VERB)
}

/** 入参片段:半截 JSON 解析出来的结果,字段可能缺 */
type PartialInput = Record<string, unknown> | undefined

function str(input: PartialInput, key: string): string | undefined {
  const value = input?.[key]
  return typeof value === 'string' && value ? value : undefined
}

/** 只取域名。完整 URL 太长,而"去了哪个站"才是用户关心的 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 40)
  }
}

function num(input: PartialInput, key: string): number | undefined {
  const value = input?.[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * 算一句展示用的标签。入参不全时尽量给出已知的部分。
 */
export function labelFor(toolName: string, input: PartialInput): string {
  const verb = verbOf(toolName)
  const path = str(input, 'path')

  switch (toolName) {
    case 'install_skill':
    case 'install_mcp': {
      const target = str(input, 'name') ?? str(input, 'summary')
      return target ? `${verb} ${target}` : verb
    }
    case 'activate_skill': {
      const name = str(input, 'name')
      return name ? `${verb} ${name}` : verb
    }
    case 'web_search': {
      const query = str(input, 'query')
      return query ? `${verb} ${query}` : verb
    }
    case 'web_fetch':
    case 'browser_open': {
      const url = str(input, 'url')
      // 只显示域名:完整 URL 会把活动条撑得很长,而域名足够让用户知道去了哪
      return url ? `${verb} ${hostOf(url)}` : verb
    }
    case 'browser_click': {
      const why = str(input, 'why')
      return why ? `${verb} ${why}` : verb
    }
    case 'read_file': {
      if (!path) return verb
      const from = num(input, 'start_line')
      const to = num(input, 'end_line')
      if (from && to) return appText('messages.lines', verb, path, from, to)
      if (from) return appText('messages.fromLine', verb, path, from)
      return `${verb} ${path}`
    }
    case 'get_range': {
      if (!path) return verb
      const from = num(input, 'start_line')
      return from ? `${verb} ${path}:${from}` : `${verb} ${path}`
    }
    case 'search_files': {
      const query = str(input, 'query')
      const glob = str(input, 'glob')
      if (!query) return verb
      return glob ? `${verb} “${query}” (${glob})` : `${verb} “${query}”`
    }
    case 'list_files': {
      const glob = str(input, 'glob')
      return glob ? `${verb} ${glob}` : verb
    }
    case 'multi_edit_file': {
      if (!path) return verb
      const edits = input?.edits
      const count = Array.isArray(edits) ? edits.length : 0
      return count ? appText('messages.changes', verb, path, count) : `${verb} ${path}`
    }
    case 'move_file':
    case 'copy_file': {
      const from = str(input, 'from')
      const to = str(input, 'to')
      if (from && to) return `${verb} ${from} → ${to}`
      return from ? `${verb} ${from}` : verb
    }
    case 'apply_patch': {
      // 补丁正文可能很长,只数一下动了几个文件
      const patch = str(input, 'patch')
      if (!patch) return verb
      const files = patch.match(/^\*\*\* (?:Update|Add|Delete) File:/gm)?.length ?? 0
      return files ? appText('common.files', verb, files) : verb
    }
    case 'check_syntax':
      return path ? `${verb} ${path}` : appText('messages.changesFromThisTurn', verb)
    case 'view_image':
    case 'note_image':
      return verb
    default:
      return path ? `${verb} ${path}` : verb
  }
}

/**
 * 工具结果压成一句话。
 *
 * 结果本身可能是几百行带行号的文件正文,原样推给渲染层没有意义——用户
 * 要的是"成没成、影响了什么",细节在右边代码区看。
 */
export function summarize(toolName: string, output: unknown): { ok: boolean; summary?: string } {
  if (typeof output !== 'string') {
    // view_image 之类返回结构化内容的,没什么好总结
    return { ok: true }
  }
  if (output.startsWith(appText('common.errorLabel'))) {
    return { ok: false, summary: output.slice(0, 120) }
  }

  switch (toolName) {
    case 'search_files': {
      const hit = /^(\d+) (?:处匹配|matches)/.exec(output)
      if (hit) return { ok: true, summary: appText('common.matches', hit[1]) }
      return {
        ok: true,
        summary: output.startsWith(appText('common.noMatches'))
          ? appText('common.noMatches')
          : undefined
      }
    }
    case 'read_file':
    case 'get_range':
    case 'outline_file': {
      const lines = output.split('\n').length
      return { ok: true, summary: appText('common.lines', lines) }
    }
    case 'list_files':
      return { ok: true, summary: appText('common.filesLabel', output.split('\n').length) }
    case 'check_syntax':
      return {
        ok: true,
        summary: output.includes(appText('messages.noStructuralIssuesFound'))
          ? appText('common.noIssues')
          : appText('common.issuesFound')
      }
    case 'diff_changes':
      return { ok: true }
    default: {
      /*
       * 写类工具返回的是「已写入 <路径>」,而标签里已经是「写入 <路径>」了——
       * 同一个路径在一行里出现两次,纯噪音,长路径还会把整行挤变形。
       *
       * 成功与否由行首的 ✓ 表示,不需要再用文字说一遍。所以"动词 + 单个路径"
       * 这种形状直接不给摘要;带额外信息的(如「已编辑 3 处」)照常保留。
       */
      if (/^(?:已[\u4e00-\u9fa5]{1,3}|Written|Edited|Deleted|Created)\s+\S+$/.test(output))
        return { ok: true }
      return { ok: true, summary: output.length <= 60 ? output : undefined }
    }
  }
}
