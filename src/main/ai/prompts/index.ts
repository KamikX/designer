import type { ArtifactFile, Project } from '../../../shared/types'
import { FILE_PROTOCOL } from './protocol'
import { CRAFT_CORE } from './craft-core'
import { stackPrompt } from './stacks'

/**
 * system prompt 组装。
 *
 * 段落按**稳定性分区**(借 open-design 的缓存前缀纪律):
 *
 * - 项目稳定区(整个项目不变,可被前缀缓存命中):身份 → 模式 → 端契约 →
 *   项目背景 → 协议 → 技术栈 → 手艺底线 → 技能目录
 * - 稳定区的尾巴(内容本身稳定,但"这一轮取哪一份"逐轮变):端模板(按活动端
 *   路由)、本地授权范围(带着这句话里识别出的路径)
 * - 逐轮可变区(每轮都可能不同,放尾部,不污染前缀):当前设计稿 →
 *   预览报错 → 反 AI 味检查 → 收尾要求
 *
 * 预览报错和 lint 结果原来排在头部第 3/4 段——那既让每一轮的前缀都不一样
 * (缓存全废),又把最需要立刻行动的信息放在了离生成最远的位置。挪到尾部
 * 一举两得:前缀稳定,且 recency 偏置恰好落在"这轮必须修的问题"上。
 *
 * 端模板与本地范围同理,只是更隐蔽:它们看着像"项目属性",实际一个按用户这句话
 * 路由活动端、一个带着本轮识别出的路径,**每轮都可能变**。夹在中段时,它们一变
 * 就把后面的手艺底线和技能目录一起带下水——前缀缓存对"哪个字节变了"没有偏好,
 * 只认第一个不同的位置。所以它们排在稳定区最后一格。
 *
 * 规范排在协议之前是有意的:协议讲"怎么写文件",规范讲"写成什么样"。
 * 模型读 prompt 时越靠前的约束越容易守住,而设计质量正是这个产品的命根子。
 *
 * 两种协议模式:
 * - markers:老路子,注入 <antdFile> 协议 + 当前版本全部文件全文。
 * - tools:模型有工具调用能力时走这条,只注入文件树,正文由模型按需
 *   read_file。输入 token 同样降一个数量级——这是 VFS 的另一半收益。
 *
 * 两套协议不能同时出现:一起给模型会混用(一边调 edit_file 一边吐
 * <antdFile>),所以 tools 模式下 FILE_PROTOCOL 整段不注入。
 */
export type PromptMode = 'markers' | 'tools'

export function buildSystemPrompt(
  project: Project,
  currentFiles: ArtifactFile[],
  options: {
    mode?: PromptMode
    localScope?: string
    /** 上一版预览的运行时错误。跑不起来比任何设计意见都优先——放尾部可变区吃 recency */
    previewError?: string
    /** 上一版产物的反 AI 味检查结果。和 previewError 一样放尾部可变区 */
    slopLint?: string
    /** 文件系统技能的目录(渐进披露的 L1),由 skills/catalog 生成 */
    skillCatalog?: string
    /** 项目视觉方向：首次确认 / 已有风格 / 延续现有文件三种分支，由 style-brief 生成 */
    styleBriefPrompt?: string
    /** 端契约:勾选端的角色定位 + 提问纪律 + 多端交付结构,由 prompts/targets 生成 */
    targetContract?: string
    /** 勾选端的设计模板正文,组装期直接注入(不走 activate_skill) */
    targetTemplates?: string
  } = {}
): string {
  const mode = options.mode ?? 'markers'
  const modeText =
    project.designMode === 'design'
      ? '追求高质量、可直接交付的视觉与交互:统一的间距与层级、精心的配色与字体、合理的空态与 hover 反馈。'
      : '追求快速验证想法的原型:结构与流程优先,视觉从简。原型模式下设计体系仍要建立,只是可以简化到主色 + 中性色两组。'

  const sections = [
    // ---- 项目稳定区 ----
    '你是一名资深产品 UI 设计师兼前端工程师,在桌面设计工具中与用户协作产出设计稿。',
    modeText,
    options.styleBriefPrompt ?? '',
    options.targetContract ?? '',
    project.description ? `项目背景:${project.description}` : '',
    mode === 'tools' ? TOOL_PROTOCOL : FILE_PROTOCOL,
    stackPrompt(project.stack, project.libs ?? []),
    CRAFT_CORE,
    options.skillCatalog ?? '',
    // ---- 稳定区的尾巴:内容稳定但**这一轮取哪份**会变,排最后才不牵连前面 ----
    options.targetTemplates ?? '',
    options.localScope ?? '',
    // ---- 逐轮可变区 ----
    mode === 'tools' ? renderFileTree(currentFiles) : renderCurrentFiles(currentFiles),
    options.previewError ?? '',
    options.slopLint ?? '',
    CLOSING
  ]
  return sections.filter(Boolean).join('\n\n')
}

const CLOSING = `
解说用中文,简短聚焦在设计决策本身(为什么是这个主色、这个层级怎么来的),
不要复述你调了哪些工具——那些用户在界面上看得到。文件内容完整可运行。
`.trim()

const TOOL_PROTOCOL = `
## 文件操作协议

设计稿文件通过工具读写,不要把文件内容直接写在回复正文里——正文只放给用户看的解说。

**动手之前**

- ask_user:方向不明确就先问。风格、配色、信息密度这类事猜错一版的代价是整份设计稿重出,
  而问一次用户只要点几下。已经说清楚的、你自己能定的小事不要问;用户跳过就按自己的判断继续,
  不要再问第二次。

**参考图**

用户提供的图只在他发出的那一轮带着像素,之后的历史里只剩引用和一句描述。

- 第一次看到图时,用 note_image 把要点记下来(配色、布局特征、气质),写具体些。
  记了之后后面多数轮次靠这句话就够,不必再看图。
- 确实需要看具体像素时(取准确颜色、看清某个组件的形状)才用 view_image。图片按尺寸计费,
  不便宜,描述能回答的问题就别调它。

**定位(按这个顺序,能停就停,不要习惯性整份读文件)**

1. search_files:全文搜索,返回"路径:行:列"和命中行。多数修改到这一步就定位完了。
2. outline_file:看文件骨架(区块 / 选择器 / 顶层声明,带行号),确定要改的东西在哪一段。
3. read_file:**带上 start_line / end_line 只读那一段**。不带区间会被截断。
4. get_range:按行列把原文精确取出来(不带行号),直接拿去当 old_string,不要手抄。

**修改(选能一次改完的那个)**

- edit_file:改一处。old_string 要与原文逐字符一致(含缩进与空行)且在文件中唯一。
- multi_edit_file:同一个文件改多处,一次调完,全成或全不成。
- apply_patch:跨多个文件的**短行、格式规整**改动,一个补丁全部搞定。
- apply_string_edits:按锚点编辑,不需要复述原文。锚点来自 capture_range 或
  search_files 的 matchId;支持 replace / remove / insert_before / insert_after,跨文件原子提交。
- write_file:新建文件,或改动幅度大到重写更划算时。内容必须完整,不允许"其余保持不变"这类占位。
- move_file / copy_file:改名、挪位置、做副本。这几件事不要用 write_file + delete_file 代替,
  那会把整份内容白吐一遍。
- delete_file:删除文件。

**什么时候必须切换到锚点编辑(capture_range / matchId + apply_string_edits)**

- 目标行超过 800 字符,或读取/搜索结果里显示被截断——截断的预览抄进 old_string 必然失配;
- 第一次出现 MATCH_NOT_FOUND / MATCH_AMBIGUOUS:不要原样重试,也不要凭记忆修补 old_string;
- 大段 Vue 模板、长数组、columns、options 这类内容。
同文件文本补丁失败两次后会被程序禁用,只能走锚点编辑;连续三次写入失败会暂停写入,
必须先用 search_files / read_file / capture_range 重新定位。

**收尾**

- check_syntax:确认括号与标签都配对了,别把结构坏掉的版本交出去。它还会对超过 800 字符的
  单行给出可编辑性警告——大型数组 / columns / options 请多行格式化(警告不阻止保存)。
- diff_changes:自查这一轮动了什么,不要靠重读文件来确认。
- revert_file:某个文件改坏了就退回本回合开始的样子,别试图重写着改回来。

规则:
1. 路径一律用相对路径,不允许出现 .. 或以 / 开头。
2. 先看原文再改,不要凭记忆构造 old_string;锚点对不上时先 search_files 而不是猜。
3. 每多一轮工具调用,整个对话都要重发一遍,所以能合并的改动就合并成一次调用。
4. 工具错误都带 [code: X] 和"下一步"建议,按建议行动;同一个失败绝不用同样的参数重试第二次。
`.trim()

/**
 * tools 模式:只给树,正文让模型自己按需读。
 *
 * 顺手把行数一起给出来——模型看一眼就知道哪些文件大到不该整份读,
 * 省掉一次"读了才发现太大"的往返。
 */
function renderFileTree(files: ArtifactFile[]): string {
  if (files.length === 0) {
    return '## 当前设计稿\n\n还没有任何文件,这是第一版,请用 write_file 从入口文件开始创建。'
  }
  const tree = files
    .map((f) => {
      const lines = f.content ? f.content.replace(/\n$/, '').split('\n').length : 0
      return `- ${f.path}(${lines} 行)`
    })
    .join('\n')
  return `## 当前设计稿\n\n文件树:\n${tree}\n\n先 search_files / outline_file 定位,再按区间 read_file。`
}

/** markers 模式:全文注入,只在这里注入一次(单点) */
function renderCurrentFiles(files: ArtifactFile[]): string {
  if (files.length === 0) {
    return '## 当前设计稿\n\n还没有任何文件,这是第一版,请从入口文件开始创建。'
  }
  const tree = files.map((f) => `- ${f.path}`).join('\n')
  const bodies = files
    .map((f) => `<antdFile path="${f.path}">\n${f.content.trimEnd()}\n</antdFile>`)
    .join('\n\n')
  return `## 当前设计稿(最新版全文)\n\n文件树:\n${tree}\n\n${bodies}\n\n修改时只输出变化的文件。`
}
