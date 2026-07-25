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
  list_files: '列出文件',
  outline_file: '查看结构',
  read_file: '读取',
  get_range: '取原文',
  search_files: '搜索',
  edit_file: '编辑',
  multi_edit_file: '批量编辑',
  apply_patch: '应用补丁',
  write_file: '写入',
  move_file: '移动',
  copy_file: '复制',
  delete_file: '删除',
  diff_changes: '查看本轮改动',
  check_syntax: '结构自检',
  revert_file: '撤销修改',
  set_style_brief: '更新视觉方向',
  ask_user: '向你提问',
  view_image: '查看参考图',
  note_image: '记录参考图要点',
  get_current_time: '查看当前时间',
  activate_skill: '加载技能',
  install_skill: '安装技能',
  install_mcp: '安装 MCP 服务',
  // 本地文件
  list_local_dir: '浏览目录',
  check_local_path: '检查路径',
  find_local_files: '查找文件',
  search_local: '搜索本地',
  read_local_file: '读取本地文件',
  read_local_document: '解析文档',
  read_document_images: '看文档图片',
  // 联网
  web_search: '联网搜索',
  web_fetch: '打开网页',
  browser_open: '打开网页',
  browser_snapshot: '查看页面',
  browser_click: '点击',
  browser_fill_form: '填写表单',
  browser_press_key: '按键',
  browser_scroll: '滚动页面'
}

export function verbOf(toolName: string): string {
  return VERB[toolName] ?? toolName
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
      if (from && to) return `${verb} ${path} ${from}-${to} 行`
      if (from) return `${verb} ${path} 第 ${from} 行起`
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
      return count ? `${verb} ${path}(${count} 处)` : `${verb} ${path}`
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
      return files ? `${verb}(${files} 个文件)` : verb
    }
    case 'check_syntax':
      return path ? `${verb} ${path}` : `${verb}(本轮改动)`
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
  if (output.startsWith('错误:')) {
    return { ok: false, summary: output.slice(0, 120) }
  }

  switch (toolName) {
    case 'search_files': {
      const hit = /^(\d+) 处匹配/.exec(output)
      if (hit) return { ok: true, summary: `${hit[1]} 处匹配` }
      return { ok: true, summary: output.startsWith('没有匹配') ? '没有匹配' : undefined }
    }
    case 'read_file':
    case 'get_range':
    case 'outline_file': {
      const lines = output.split('\n').length
      return { ok: true, summary: `${lines} 行` }
    }
    case 'list_files':
      return { ok: true, summary: `${output.split('\n').length} 个文件` }
    case 'check_syntax':
      return { ok: true, summary: output.includes('没发现结构问题') ? '没问题' : '发现问题' }
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
      if (/^已[\u4e00-\u9fa5]{1,3}\s+\S+$/.test(output)) return { ok: true }
      return { ok: true, summary: output.length <= 60 ? output : undefined }
    }
  }
}
