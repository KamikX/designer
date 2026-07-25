/**
 * 文件输出协议说明,所有技术栈模板共用。
 * few-shot 是护栏的第一层:弱一些的模型(尤其 openai-compatible 长尾)
 * 靠示例比靠描述可靠得多。
 */
export const FILE_PROTOCOL = `
## 文件输出协议

产出或修改设计稿文件时,必须使用以下标记格式,标记行必须独占一行:

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
`.trim()
