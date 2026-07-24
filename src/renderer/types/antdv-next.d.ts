/**
 * antdv-next 的全局组件类型（AButton / AModal / ATable ...）。
 * 只在这里声明，配合 tsconfig.web.json 的 include，保证仅渲染进程可见，
 * 主进程 / preload（tsconfig.node.json）不会受到影响。
 */
/// <reference types="antdv-next/global" />

export {}
