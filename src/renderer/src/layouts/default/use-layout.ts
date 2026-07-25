/**
 * default 布局的骨架常量。
 *
 * 只服务于这套布局，所以放在 layout 目录下，不往 components/config 里塞——
 * 那边是全局配置中心，不是状态仓库。
 */

/**
 * 侧栏宽度。
 *
 * 没有顶栏之后红绿灯直接落在侧栏上，三个按钮整体跨度约 58px
 * （尺寸和间距由 macOS 决定，Electron 改不了），配合 main 里
 * trafficLightPosition 的 x=6，右边缘到 64px。这个值不能再小，
 * 否则绿灯会溢出到内容区上面。
 */
export const RAIL_WIDTH = 72

/**
 * 顶部拖拽条高度。
 *
 * 这条是纯拖拽区，范围内一切都点不了，所以尽量压薄：
 * 红绿灯在 y=12、直径 12px，底边到 24px，28 刚好放下再留 4px。
 * 内容区顶部因此不再另加 padding，这条本身就是那段留白。
 */
export const DRAG_BAR_HEIGHT = 28
