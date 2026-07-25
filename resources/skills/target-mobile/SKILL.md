---
name: target-mobile
description: 移动端 App 界面的设计模板。Use when 项目勾选了移动端,或用户要做手机 App、iOS/Android 界面、小程序风格的屏幕。不适用:响应式网页的手机断点(那是 target-web 的事)、落地页。
metadata:
  kind: target
  target: mobile
---

# 移动端 App

移动端产物在桌面预览里必须**画在真机框里居中呈现**,画布用 `bg-bg`,
设备浮在上面。不画机框的"手机宽度网页"看起来就是个窄网页,不是 App。

## 开工前:判读与提问

判读一句话:「这是〈哪类屏〉,给〈谁〉在〈什么场景〉用,气质偏〈iOS / Android / 中性〉。」
缺关键信息才问,最多一次,不超过 3 题:

1. **首屏类型**(下面路由表的六选一,brief 多半能推断,推断不出才问)
2. **平台气质**:iOS(默认) / Android / 中性
3. **明暗**:浅色(默认) / 深色 / 跟随内容气质

信号追问:

| 用户提到 | 追问 |
| --- | --- |
| 列表、信息流 | 空态放什么?第一次打开没有数据时用户看见什么 |
| 表单、发布 | 什么时候校验?(默认:失焦校验,提交兜底) |
| 支付、金额 | 币种与千分位格式;金额一律 `.num` 等宽 |
| 多屏、流程 | 先交付哪一屏?**一次一屏**,其余做成后续提议 |

## 屏型路由

| brief 里出现 | 用 |
| --- | --- |
| 信息流、消息、动态、列表 | A 信息流:顶栏 + 卡片流 + tab 栏 |
| 商品、文章、歌曲、菜谱详情 | B 详情:大图/头部 + 内容 + 底部固定操作条 |
| 注册、欢迎、引导、开屏 | C 引导:整屏一个主张 + 一个按钮,可滑动分页 |
| 记账、打卡、统计、健康 | D 仪表:顶部大数字 + 图表 + 明细列表 |
| 设置、我的、个人资料 | E 个人页:头部资料卡 + 分组列表 |
| 发布、填写、提交 | F 表单:单列字段 + 底部主按钮 |

**一屏只做一件事。** brief 像两件事时,交付主要那屏,另一屏口头提议。

## 风格维度:每一项都要做选择,别每次都默认同一组

屏型管结构,这里管气质。**用户给了方向听用户的**;没给就按 brief 选,判读时
逐项声明,**连续两个项目不许选同一组**:

| 维度 | 选项 |
| --- | --- |
| 平台气质 | iOS(默认) / Android Material / 中性 |
| 明暗 | 浅色 / 深色 / 首屏深色内容浅色 |
| tab 栏形态 | 通栏贴底(默认) / 浮岛胶囊(悬浮、圆角、留边) |
| 卡片风格 | 描边卡片 / 无边框平铺+分割线 / 大圆角浮卡(带轻阴影) |
| 头部形态 | 大标题(iOS Large Title) / 紧凑顶栏 / 沉浸头图 |

品牌色按 design-seed 的规则定(用户方向优先,占位色必换)。

## 机框骨架(直接抄,别重画)

```html
<div class="min-h-screen bg-bg flex items-center justify-center py-10">
  <div class="w-[390px] h-[844px] rounded-[56px] bg-ink p-[10px] shadow-2xl">
    <div class="w-full h-full rounded-[46px] bg-surface overflow-hidden relative flex flex-col">
      <!-- 状态栏:时间用全强度前景色,不是灰色 -->
      <div class="h-[54px] flex items-end justify-between px-8 pb-2 text-ink text-[15px] font-semibold">
        <span class="num">9:41</span>
        <div class="absolute top-[12px] left-1/2 -translate-x-1/2 w-[120px] h-[34px] rounded-full bg-ink"></div>
        <span class="flex gap-1 items-center"><!-- 信号/wifi/电池:内联 SVG --></span>
      </div>
      <div class="flex-1 overflow-y-auto"><!-- 屏幕内容 --></div>
      <!-- tab 栏(需要时);home indicator 永远要 -->
      <div class="h-[34px] flex items-center justify-center">
        <div class="w-[134px] h-[5px] rounded-full bg-ink opacity-90"></div>
      </div>
    </div>
  </div>
</div>
```

## 硬规则

- 点击目标 ≥44×44px;主按钮高度 48px 起,放拇指够得着的下半屏。
- tab 栏最多 5 项;当前项用 `text-brand-500`,其余 `text-ink-muted`,图标单线 SVG。
- 列表必须做四态:有数据 / 空态(一句话 + 一个动作) / 加载(骨架屏) / 出错(能重试)。
- 正文 ≥15px;辅助文字 ≥12px,再小就不是给人看的。
- 数字(金额、计数、时间)一律 `.num` 等宽。

## 交付前自查:假手机现象

出现任何一条,说明你做的是"假装成手机的卡片",回去修:

- [ ] 外框圆角(56px)没有明显大于屏幕圆角(46px)
- [ ] 顶部中央没有灵动岛挖孔
- [ ] 状态栏时间是灰色或半透明(应当是全强度 `text-ink`)
- [ ] 底部没有 home indicator
- [ ] 内容从状态栏底下穿过或顶到物理边缘(安全区没留)
