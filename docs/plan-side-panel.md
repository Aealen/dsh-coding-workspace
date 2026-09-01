# 侧栏右栏:工作区面板(资源管理器 + Git)设计方案

> 分支 `feature/git-info-panel` · v1 设计定稿 · 2026-09-01

## 1. 目标与范围

在 dsh 右侧新增常驻工作区面板,当前会话所在工作区一目了然:文件浏览 + Git 状态/历史 + 常用 Git 操作。UI 参考 JetBrains IDEA 的 Git Log 视图(彩色 lane graph、变更文件树、工具按钮行),收窄为右栏形态。

### v1 范围

| 模块 | 能力 | 读/写 |
| --- | --- | --- |
| 资源管理器 | 当前工作区文件树,懒展开,过滤噪音目录 | 只读 |
| Git · Changes | Staged / Unstaged / Untracked 分组,状态徽标分色 | 读 |
| Git · Changes 操作 | 单文件 stage/unstage,输入消息 commit | 写(显式操作) |
| Git · Logs | 彩色 lane git graph + commit 列表,行展开看变更文件 | 只读 |
| Git · 同步 | Fetch / Pull(仅 ff)/ Push(自动 -u) | 写(显式操作) |
| 跟随策略 | 跟随当前会话 cwd 定位工作区 | — |

### v2 留待(不在本次)

- 文件 diff 查看(点击文件看变更内容)
- discard 单文件/全部(破坏性,需二次确认 UI)
- Logs 分页滚动加载、分支/作者/日期筛选器
- 资源管理器「显示隐藏文件」开关、点击文件行为
- stash / branch 操作、pull 冲突引导
- 推挤式布局(改 frame grid,让面板挤占会话区而非浮层)

## 2. 总体架构

### 2.1 挂载:shell.overlay(调研已定案)

- `shell.overlay` 是 ui-layout AppFrame 声明的 **list slot**(`kind: 'list', scope: 'root'`),additive、零官方占据者(`occupants: []`)、`replaceRisk: "none"`——官方文档原文点名「frame-wide floating layer, a fresh id is added beside the shipped entries」。
- 渲染层:`.overlayLayer { position:absolute; inset:0; z-index:20; pointer-events:none }`,子元素自动 `pointer-events:auto`。层穿透、面板交互,零冲突。
- 注册姿势(与现有侧栏同款):

```ts
ctx.slots.inject('shell.overlay', () => ctx.slots.register(
  { name: 'shell.overlay', id: 'dsh-worktree.side-panel', order: 100 },
  SidePanel,
))
```

- entry 组件 props 官方白送 `useSessions` / `useWorkspaces`(root scope 标准 kit),当前会话 `useSessions(s => s.current)` 直接取,免轮询。

### 2.2 跟随策略

1. `useSessions` 快照取当前会话 → `byId[current].cwd`。
2. cwd 归属工作区:复用现有血缘(`worktree-lineage.json` edges 的 `workspaceId`/`parentPath`)+ workspace registry `useWorkspaces` 快照,与侧栏分组同一套归属逻辑(抽公共函数)。
3. 主仓会话 → 主仓目录;worktree 会话 → worktree 目录;无会话/目录非 git 仓库 → 面板空态(「当前没有活动工作区」)。
4. 会话切换即时跟随(uSES 订阅,零轮询);数据刷新 = 手动 ⟳ + 每次面板打开 + 写操作完成后自动刷新相关区。

### 2.3 显隐与形态

- **展开**:右缘浮层面板,`position:absolute; top:0; right:0; bottom:0; width:360px`(可拖宽,v1 固定 320–420 两档?——v1 固定 360,拖宽 v2),左 1px border + 轻阴影,`pointer-events:auto`。
- **收起**:右缘中部一个 36px 圆角竖条把手(分支 icon),hover 亮,点击展开;展开态头部 ✕ 收起。默认收起,状态记忆 localStorage(`dsh-worktree.panel`)。
- 展开/收起 width/transform 过渡沿用宿主节奏 `var(--ds-transition-duration-slow) var(--ds-ease-in-out)`。

## 3. UI 设计

### 3.1 视觉语言(与侧栏同一套)

- 官方 alias tokens:背景 `--dsw-alias-bg-base`、边框 `--dsw-alias-border-l1/l2`、文本 `primary/secondary/tertiary`、hover `--dsw-alias-interactive-bg-hover`、成功 `--dsw-alias-state-success-primary`。
- 字号沿用侧栏基准:标题 14、行文 13、辅助 12、mono(hash/路径)12。
- 行高:列表行 30–32px,紧凑但不挤;区块间距 8。
- 状态徽标:14×14 圆角方块,mono 11px 字母,分色见 §3.4。
- 图标:官方 primitives 优先(`StateDot`/`IconCheckOutline16` 已验证);分支/文件夹等沿用侧栏自绘 SVG,风格一致。

### 3.2 面板骨架

```
┌────────────────────────────┐
│ 资源管理器 | Git         ✕ │ ← TAB 栏(下划线式,主色 2px 激活)
├────────────────────────────┤
│ 🌿 feature/login  ▲1 ▼0 ⟳ │ ← 工作区状态条(随 TAB 换内容)
├────────────────────────────┤
│                            │
│       TAB 内容滚动区        │
│                            │
└────────────────────────────┘
```

- 状态条:资源管理器 TAB = 工作区名 + 路径短名;Git TAB = 分支 + upstream + ▲ahead ▼behind + Fetch/Pull/Push 按钮。
- ✕ 收起为把手;把手态右缘 36px 竖条,分支 icon 居中。

### 3.3 TAB 1:资源管理器

```
🌿 feature/login · dsh-worktree          ⟳
────────────────────────────────────────
▾ 📁 src
  ▾ 📁 tools
      📄 lineage-route.ts
      📄 git-info-route.ts
  ▸ 📁 client
▸ 📁 test
    📄 package.json
    📄 tsconfig.json
```

- 根 = 当前工作区 cwd;懒展开(点文件夹拉子层,状态存组件内 Map)。
- 排序:文件夹在前、字母序;过滤 `.git` / `node_modules` / `__pycache__` / `.DS_Store`(`.worktree/` 若在主仓同样过滤)。
- 行:icon(文件夹/文件,文件夹区分展开态)+ 名称;hover 高亮;tooltip 显示大小/修改时间。
- v1 纯只读,点击文件无动作(v2 diff/打开)。
- 目录穿越防护:后端强制 resolve(dir) 必须落在 root 内,越界 400。

### 3.4 TAB 2:Git · Changes

子 TAB 切换:`Changes | Logs`(胶囊或下划线,12–13px)。

```
🌿 feature/login ↑1 ↓0   [Fetch] [Pull] [Push]
──────────────────────────────────────────────
 Changes | Logs
──────────────────────────────────────────────
 ▾ 暂存的更改 (2)                          [提交]
     [M] src/git.ts
     [A] src/tools/git-info-route.ts
 ▾ 未暂存的更改 (1)
     [M] src/client.tsx        [+]
 ▾ 未跟踪 (1)
     [?] docs/plan-side-panel.md [+]
──────────────────────────────────────────────
 [提交信息输入框…                ]  (Ctrl+Enter)
```

- 状态徽标分色(IDEA 风):`M` 黄 / `A` 绿 / `D` 红 / `R`·`C` 蓝 / `U`(冲突)橙 / `?`(未跟踪)灰。色值优先官方 state alias tokens,缺位用固定色兜底(实现时探明)。
- 文件行:目录前缀 tertiary 淡色 + 文件名 primary 亮色(IDEA 风);hover 出操作(+ stage / − unstage)。
- 分组头可折叠,计数右侧。
- 提交区:staged > 0 启用;输入框 textarea autosize(≤4 行),`Ctrl+Enter` 提交;成功后清空并刷新。
- Fetch/Pull/Push 在 Git TAB 状态条常驻;Pull 用 `--ff-only`,失败如实 toast(避免 merge 泥潭);Push 无 upstream 自动 `-u origin <branch>`;ahead/behind 在按钮旁小红点提示可同步。

### 3.5 TAB 2:Git · Logs(IDEA Git Log 收窄版)

IDEA 三栏(分支树 | graph 列表 | 详情)在 360px 内重排为单列 + 行内展开:

```
 Changes | [Logs]                    分支: [当前分支 ▾]
──────────────────────────────────────────────
 │ ● fix(resource): 修复登录跳转        origin/login
 │ │   a1b2c3d  张三 · 3 小时前
 │ ● feat: 新增面板骨架
 ○ │   9f8e7d6  李四 · 昨天
 │ ○ Merge branch 'dev' into main
 ●/   4d5c6b7  张三 · 2 天前
```

- **graph 渲染**:后端 `git log --graph --date-order --pretty=...` 拿 ASCII graph,前端逐字符转 SVG(星=圆点、| 竖线、\ / 斜线、_ 横线),每 lane 宽 10px、行高 22px,lane 序数循环取色板(6–8 色,IDEA 同款饱和度)。不重算拓扑,git 画好我们只做几何映射。
- 行主行:subject 单行 ellipsis;refs(`origin/xxx`、`HEAD → main`、tag)小徽标右对齐,mono 10px;次行:短 hash(mono 主色)+ author + 相对时间,tertiary 12px。
- 选中/展开:点击行展开 inline 详情——完整 message(pre-wrap)+ 全 hash/author/date + 变更文件列表(`git show --name-status` 懒加载,复用 Changes 徽标)。再点收起。同屏只展开一个。
- 分支筛选下拉(v1 两档):`当前分支`(默认,HEAD 可达)/ `全部分支`(`--all`)。IDEA 的 Branch/Date/Author 筛选器 v2。
- 加载:首屏 50 条,底部「加载更多」(`--skip` 递增);手动 ⟳ 重置。

### 3.6 空态与错误态

- 无活动会话 / cwd 非 git 仓库:面板居中 tertiary 文案 + 把手 icon,不报错。
- git 命令失败(toast 沿用侧栏现有 toast 通道):错误信息如实转述,不吞。
- 大仓库防护:fs-list 单目录 >500 项截断提示;log 单次 ≤100。

## 4. 后端路由(全部 `runGit`,白名单参数)

沿用 `src/git.ts` 的 `runGit`(Windows git 绝对路径探测已内置)。新增 `src/tools/panel-routes.ts`:

| 路由 | 入参 | 出参 | 说明 |
| --- | --- | --- | --- |
| `POST /dsh-worktree/fs-list` | `root, dir?` | `entries: {name, type, size?, mtime?}[]` | dir 越界 400;噪音目录已滤 |
| `POST /dsh-worktree/git-overview` | `cwd` | `branch, upstream, ahead, behind, isRepo` | `status -b --porcelain` 一次拿 |
| `POST /dsh-worktree/git-status` | `cwd` | `staged[], unstaged[], untracked[]` | porcelain v1 解析,X/Y 两列拆分 |
| `POST /dsh-worktree/git-log` | `cwd, mode: 'head'\|'all', skip?, limit?` | `commits: {hash, subject, author, relDate, refs[], graph}[]` | graph 原始字符列透传,前端转 SVG |
| `POST /dsh-worktree/git-show` | `cwd, hash` | `message, author, date, files: {path, status}[]` | `git show --name-status --format=`,hash 白名单校验 `^[0-9a-f]{7,40}$` |
| `POST /dsh-worktree/git-action` | `cwd, action, ...` | `{ok, output?}` | **写操作唯一入口**,action 白名单见下 |

`git-action` 白名单:

| action | git 命令 | 附加入参 |
| --- | --- | --- |
| `stage` | `add -- <path>` | `path`(单文件) |
| `unstage` | `restore --staged -- <path>` | `path` |
| `commit` | `commit -m <msg>`(仅 staged;`-a` 不提供) | `message` |
| `fetch` | `fetch --prune` | — |
| `pull` | `pull --ff-only` | — |
| `push` | `push` / 无 upstream 时 `push -u origin <branch>` | — |

安全边界:

- 所有路由 cwd 必须命中「当前会话工作区」同源校验:路径在血缘 edges 或 registry 已知路径集合内,否则 403(防任意路径 git 执行)。
- 写操作仅上表六种,参数白名单拼装,不走 shell;错误如实回传。
- hash/ref 类入参强校验格式后才进 git 参数。

## 5. 工程落点

| 项 | 方案 |
| --- | --- |
| 前端 | 新文件 `src/panel.tsx`(SidePanel/ExplorerTab/ChangesView/LogsView + graph SVG 组件),`client.tsx` import 并注册 slot;同 bundle 产出 |
| 公共逻辑 | cwd→工作区归属从 client.tsx 抽 `src/workspace-locate.ts`?——v1 先放 panel.tsx 内,稳定后再抽 |
| 状态 | 面板内 useState + uSES;无全局 store;localStorage 记显隐 |
| 样式 | inline style(与 client.tsx 现状一致),token 全走官方 alias |
| 测试 | 后端路由解析函数(porcelain 解析、graph 行解析、越界校验)纯函数 + node --test;前端沿用现无测试现状 |
| 里程碑 | M1 后端路由+单测 → M2 面板骨架+资源管理器 → M3 Changes+写操作 → M4 Logs graph → 真机验收 |

## 6. 风险与备忘

- **overlay z-index 20 vs 宿主 Modal**:宿主 Modal portal 到 body 且层级更高(待真机确认),面板不应盖住 Modal;若冲突,面板内弹层(zustand 无关)降级用宿主 primitives Menu。
- **pointer-events 漏斗**:overlay 层穿透、面板根 auto——面板内部不要再嵌套 pointer-events:none 容器,拖宽把手 v2 时注意。
- **`git status` 大仓性能**:porcelain 单次 <100ms 级,不做增量;写操作后串行刷新 overview+status,避免竞态(简单 await 链)。
- **graph ASCII 转 SVG 的边角**:`_` 与 `.` 字符、超宽 lane(>10)兜底截断;date-order 保证连线视觉稳定。
- completed 语义等宿主行为不涉及;本面板不订阅 mux 帧以外宿主私有面。
