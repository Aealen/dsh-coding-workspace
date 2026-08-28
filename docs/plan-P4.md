# dsh-worktree P4 规划:前端半区 + 侧栏「项目」分组视图

> 状态:执行中 | 日期:2026-08-28

## 已核实的机制(全部亲验源码/实包)

| 机制 | 事实 |
| --- | --- |
| 前端插件声明 | `package.json` → `"dsh": {"client": {"platform":"web","inject":[],"immediately":true,"external":[...]}}` + `exports["./client"]` |
| bundle 服务 | 宿主 Node 半区扫描启用的 loader 条目,构建 hash 后经 `/plugins/<id>/client.js?rev=` 服务 |
| 装载形态 | bundle 内容 = `window.__ModuleLoader__.load({id, factory:(require)=>{...}})`(lazy CJS);副作用(含 CSS 注入)全在 factory 闭包内 |
| 客户端插件形态 | 工厂内仍是 cordis 插件(name/inject/apply);apply 时 `ctx.modules` 即 ClientModuleLoader |
| boot 图 | `window.__DSH_BOOT__` = {rev, entries:[{id,url,rev,inject,immediately,external}]};external 请求 shell 种子(React/Cordis/静态 UI 库),同步 require,声明必须完整 |
| 侧栏 slot | `sidebar.workspaces` = kind:"single"、scope:"root"(ui-sidebar 持有,`renderSlot(name,{wide,expandSidebar})`);现占据者 ui-workspace 的占用姿势:`ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({name, children, store, ...}))` |
| 数据钩子 | 外壳向 slot 传递布局 owner share、全局 useSessions/useWorkspaces、startSession 等(SidebarRootComponentProps 契约,具体传递路径待实测) |
| 已知原生毛刺 | 侧栏 `COLLAPSED_SESSION_LIMIT=5` 折叠截断 + fork 后投影不实时 push(跳变现象根源,P4 一并解决) |

## 设计决策

- **D1 占用策略**:与 ui-workspace 同姿势 `slots.inject("sidebar.workspaces")` 注册分组视图;single 冲突语义先以最小模块实测(load 阶段行为),冲突则降级为「不抢 slot」的增强方案(挂子 slot 或独立面板)。
- **D2 数据源**:分组视图以「血缘 + workspace.list + session.list」合成父子树:一级 = 项目(git 主仓 workspace),二级 = worktree 工作区,行内会话按血缘折叠展开。单一数据源,顺带解决原生跳变。
- **D3 构建**:esbuild 打包 `src/client.ts` → `lib/client.js`,banner/footer 手搓 `__ModuleLoader__.load` 工厂形态;`react`/`react/jsx-runtime` external(经 dsh.client.external 向 shell 请求)。
- **D4 版本策略**:前端半区进同包同版本发版;bundle hash 由宿主 rev 锚定,无额外缓存管理。

## 分阶段执行

1. **M1 挂载链验证(本阶段)**:client 模块声明 + esbuild 构建 + 重装 → 验证 `__DSH_BOOT__` 出现 dsh-worktree 行、`/plugins/dsh-worktree/client.js` 可取、控制台加载日志。不占任何 slot。
2. **M2 slot 占用实测**:最小 register(临时 debug 组件)探 single 冲突语义 → 定占用或降级方案。
3. **M3 分组视图 UI**:项目树(血缘) + 会话行复用原生交互(open/start/fork 语义按 ui-workspace 对齐)。
4. **M4 投影推送**:fork/attach 后触发侧栏数据源刷新(消除手动 F5)。

## 风险

- single slot 抢占与 ui-workspace 的兼容性(M2 实测定方案)
- 外壳传给 slot 占据者的 props 契约(布局 share/useSessions 等)若不直达占据者,需从 ctx.modules/store 自取(有 ui-workspace 源码参照)
- client bundle 的 external 请求若声明不完整,装载期即抛(声明保守从宽)
