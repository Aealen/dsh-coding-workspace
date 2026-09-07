// 冒烟测试 stub:宿主 primitives 包在 node 不可用,最小具名导出替身。
// 注意不能用 Proxy 万能返回——esbuild cjs interop 探测 __esModule 会被带歪,
// 导致 bundle 自身导出解析成 stub。
exports.DeepSeekIcon = function DeepSeekIcon() {
  return null
}
exports.StateDot = function StateDot() {
  return null
}
