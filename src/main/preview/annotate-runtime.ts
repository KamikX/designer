/**
 * 预览标注运行时(跑在 iframe 里)。
 *
 * ## 为什么整段代码在这边
 *
 * 预览 iframe 是 `preview://` 协议下的另一个源,父窗口**读不到它的 DOM**,
 * 只能 postMessage。所以"高亮哪个元素、点中了什么、徽标画在哪"这些事只能
 * 由 iframe 自己做,父窗口负责的是备注输入和把结果交给模型。
 *
 * 三种栈(html / vue3 / react)共用这一份:它由 bootstrap 的 COMMON_HEAD
 * 内联,和 reportError / notifyReady 是同一类基建。
 *
 * ## 元素签名要给模型什么
 *
 * 目标是模型能**唯一定位到源码**:
 * - vue3 编译期注入了 `data-antd-src="App.vue:12:5"`,自身或祖先有就直接给坐标;
 * - 没有的(html / react)给标签、class、文本、祖先链、开标签原文,让模型
 *   `search_files` 去找。文本和 Tailwind class 串在实践中是最强的搜索锚。
 *
 * ## 消息协议
 *
 * 父 → 子:`{ __previewCmd: 'annotate', on }`、`{ __previewCmd: 'annotate:sync', marks }`
 * 子 → 父:`{ __preview: true, type: 'annotate:pick' | 'annotate:cancel', ... }`
 */
export const ANNOTATE_RUNTIME = `
<style id="__antd-annotate-style">
  /* 标注态下整页十字光标:让用户一眼看出现在点下去不是在用页面,而是在标记 */
  html.__antd-annotating, html.__antd-annotating * { cursor: crosshair !important; }
  .__antd-annotate-box {
    position: fixed; pointer-events: none; z-index: 2147483646;
    border: 2px solid #1677ff; border-radius: 3px;
    background: rgba(22, 119, 255, 0.08); transition: all 60ms ease-out;
  }
  .__antd-annotate-badge {
    position: fixed; pointer-events: none; z-index: 2147483647;
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: #1677ff; color: #fff; font: 600 11px/18px system-ui, sans-serif;
    text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }
  .__antd-annotate-ring {
    position: fixed; pointer-events: none; z-index: 2147483645;
    border: 1px dashed #1677ff; border-radius: 3px;
  }
  /* 容器自己零尺寸零交互:它挂在 <html> 下,有尺寸就会把页面撑出滚动条 */
  .__antd-annotate-layer {
    position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none;
  }
</style>
<script>
(function () {
  var on = false
  var mode = 'annotate'
  /** 父窗口给的标记:{ id, index, selector } */
  var marks = []
  var hoverBox = null
  var layer = null
  var pending = 0

  function ensureLayer() {
    if (!layer) {
      layer = document.createElement('div')
      layer.className = '__antd-annotate-layer'
      document.documentElement.appendChild(layer)
    }
    return layer
  }

  /* ---------------- 元素签名 ---------------- */

  /**
   * 从 body 起的 nth-child 路径。徽标复原、以及"同一个元素别标两次"都靠它,
   * 所以要能被 querySelector 原样吃回去——遇到 id 就收尾,短且更稳。
   */
  function selectorOf(el) {
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 12) {
      var tag = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift(tag + '#' + CSS.escape(node.id))
        return parts.join(' > ')
      }
      var parent = node.parentElement
      if (!parent) break
      var index = 1
      var sibling = node
      while ((sibling = sibling.previousElementSibling)) index++
      parts.unshift(tag + ':nth-child(' + index + ')')
      node = parent
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body'
  }

  /** 给人和模型看的祖先链,只取标签 + 首个 class */
  function pathOf(el) {
    var chain = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.body && chain.length < 6) {
      var tag = node.tagName.toLowerCase()
      var cls = node.classList && node.classList[0] ? '.' + node.classList[0] : ''
      chain.unshift(tag + cls)
      node = node.parentElement
    }
    return chain.join(' > ')
  }

  var ATTRS = ['aria-label', 'href', 'src', 'alt', 'placeholder', 'name', 'role', 'type', 'title']

  function describe(el) {
    var located = el.closest('[data-antd-src]')
    var attrs = {}
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i])
      if (v) attrs[ATTRS[i]] = String(v).slice(0, 120)
    }
    // 整段 outerHTML 太长时退回"只要开标签":属性齐了就够搜,子树是噪音
    var html = el.outerHTML || ''
    if (html.length > 400) {
      var shallow = el.cloneNode(false)
      html = shallow.outerHTML || html.slice(0, 400)
    }
    var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    var rect = el.getBoundingClientRect()
    return {
      source: located ? located.getAttribute('data-antd-src') : '',
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.prototype.slice.call(el.classList || [], 0, 8),
      text: text.slice(0, 100),
      path: pathOf(el),
      attrs: attrs,
      html: html.slice(0, 400),
      selector: selectorOf(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    }
  }

  /* ---------------- 标注模式 ---------------- */

  function setMode(next) {
    if (on === next) return
    on = next
    document.documentElement.classList.toggle('__antd-annotating', on)
    if (!on && hoverBox) {
      hoverBox.remove()
      hoverBox = null
    }
  }

  function highlight(el) {
    if (!hoverBox) {
      hoverBox = document.createElement('div')
      hoverBox.className = '__antd-annotate-box'
      ensureLayer().appendChild(hoverBox)
    }
    var r = el.getBoundingClientRect()
    hoverBox.style.left = r.left + 'px'
    hoverBox.style.top = r.top + 'px'
    hoverBox.style.width = r.width + 'px'
    hoverBox.style.height = r.height + 'px'
  }

  document.addEventListener(
    'mousemove',
    function (e) {
      if (!on) return
      var el = e.target
      if (!el || el.nodeType !== 1 || el === document.documentElement) return
      highlight(el)
    },
    true
  )

  /*
   * 标注态下把鼠标事件整组吞掉。
   *
   * 只拦 click 不够:下拉菜单、拖拽这类交互是在 mousedown / pointerdown 上
   * 起效的,点一下就把用户的设计稿"用"了一遍——弹窗弹出来、路由跳走,
   * 标的还是跳转前那个页面。
   */
  ;['pointerdown', 'mousedown', 'mouseup', 'dblclick', 'submit'].forEach(function (type) {
    document.addEventListener(
      type,
      function (e) {
        if (!on) return
        // pointerdown 上**不能** preventDefault:那会连带压掉兼容鼠标事件,
        // 而拾取正是挂在 click 上的。挡住页面自己的监听靠 stopPropagation 就够
        if (type !== 'pointerdown') e.preventDefault()
        e.stopPropagation()
      },
      true
    )
  })

  document.addEventListener(
    'click',
    function (e) {
      if (!on) return
      e.preventDefault()
      e.stopPropagation()
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
      var el = e.target
      if (!el || el.nodeType !== 1) return
      if (mode === 'source') {
        parent.postMessage({ __preview: true, type: 'source:pick', source: describe(el).source }, '*')
      } else {
        parent.postMessage({ __preview: true, type: 'annotate:pick', target: describe(el) }, '*')
      }
    },
    true
  )

  // Esc 退出标注:手已经在预览里了,不该逼用户挪回去点按钮
  document.addEventListener(
    'keydown',
    function (e) {
      if (!on || e.key !== 'Escape') return
      e.preventDefault()
      setMode(false)
      parent.postMessage({ __preview: true, type: mode === 'source' ? 'source:cancel' : 'annotate:cancel' }, '*')
    },
    true
  )

  /* ---------------- 编号徽标 ---------------- */

  function paint() {
    pending = 0
    var host = ensureLayer()
    host.innerHTML = ''
    if (hoverBox) host.appendChild(hoverBox)
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i]
      var el = null
      try {
        el = document.querySelector(mark.selector)
      } catch (err) {
        el = null
      }
      // 版本切换或重新渲染后元素可能已经不在了:静默跳过,别画一个飘在
      // 空白处的徽标误导用户
      if (!el || !el.isConnected) continue
      var r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue

      var ring = document.createElement('div')
      ring.className = '__antd-annotate-ring'
      ring.style.left = r.left + 'px'
      ring.style.top = r.top + 'px'
      ring.style.width = r.width + 'px'
      ring.style.height = r.height + 'px'
      host.appendChild(ring)

      var badge = document.createElement('div')
      badge.className = '__antd-annotate-badge'
      badge.textContent = String(mark.index)
      // 元素贴着视口顶部时徽标挪到里面,免得被裁掉
      badge.style.left = Math.max(0, r.left - 6) + 'px'
      badge.style.top = Math.max(0, r.top - 9) + 'px'
      host.appendChild(badge)
    }
  }

  function schedule() {
    if (pending) return
    pending = requestAnimationFrame(paint)
  }

  // 滚动与尺寸变化都要重定位。scroll 用捕获:内部滚动容器的滚动不冒泡
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)

  window.addEventListener('message', function (e) {
    var data = e.data
    if (!data || !data.__previewCmd) return
    if (data.__previewCmd === 'annotate' || data.__previewCmd === 'source') {
      mode = data.__previewCmd
      setMode(!!data.on)
      return
    }
    if (data.__previewCmd === 'annotate:sync') {
      marks = Array.isArray(data.marks) ? data.marks : []
      schedule()
    }
  })
})()
</script>
`.trim()
