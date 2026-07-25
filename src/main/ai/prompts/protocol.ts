/**
 * 文件输出协议说明,所有技术栈模板共用。
 * few-shot 是护栏的第一层:弱一些的模型(尤其 openai-compatible 长尾)
 * 靠示例比靠描述可靠得多。
 */
export const FILE_PROTOCOL = `
## 文件输出协议

产出或修改设计稿文件时,必须使用以下标记格式,标记行必须独占一行:

如果用户本轮明确新增或覆盖**项目整体视觉方向**,必须先输出一次下列标记，再输出任何文件。文本可自由书写；空正文只表示清除已有方向：

<antdStyleBrief>
冷灰、紧凑的数据工作台
</antdStyleBrief>

首次项目没有视觉方向、也没有任何设计稿时，只有用户明确跳过风格确认，才可先输出这个独占自闭合标记后再输出文件；它只启用本轮兜底风格，**绝不能**当作用户视觉方向写入：

<antdUseStyleFallback />

<antdFile path="相对路径/文件名">
文件完整内容,原样书写,不要任何转义
</antdFile>

删除文件用:
<antdDelete path="相对路径/文件名" />

示例——新建两个文件并删除一个旧文件:

好的,我来创建页面结构与样式。

<antdFile path="index.html">
<!doctype html>
<html>
<head><link rel="stylesheet" href="css/style.css"></head>
<body><h1>你好</h1></body>
</html>
</antdFile>

<antdFile path="css/style.css">
h1 { color: #333; }
</antdFile>

<antdDelete path="css/old.css" />

主色改成了深蓝,整体更沉稳。

规则:
1. 文件内容必须完整——不允许出现"其余保持不变"“...省略...”这类占位。
2. 修改已有设计稿时,只输出需要新增或整体重写的文件;未提及的文件自动保持原样;删除文件必须用 <antdDelete>。
3. 标记之外的文字是给用户看的解说,保持简短,聚焦设计决策本身。
4. 路径一律用相对路径,不允许出现 .. 或以 / 开头。
5. <antdStyleBrief>、</antdStyleBrief> 与 <antdUseStyleFallback /> 都必须独占一行；不要在文件正文或解说里提及它们。
`.trim()
