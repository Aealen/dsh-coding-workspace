# dsh-worktree 插件 P1/P2 实施规划

> 状态:规划定稿待执行 | 日期:2026-08-27
> P0(worktree 三工具)已交付并经真机验证。

## 一、范围

| 阶段 | 交付物 | 说明 |
| --- | --- | --- |
| 血缘层(B) | `src/lineage.ts` + 单测 | 全插件的分组数据底座,P4 前端视图直接消费 |
| P1 | `session_list` / `session_read` 两工具 | 基于 `ctx.sessionQuery`(官方 seam,亲验签名) |
| P2 | `project_fork` 工具 | worktree add + `ctx.workspaceRegistry.create()` + 血缘登记 |

P3(fork 会话)不在本批,但其依赖的 sessionQuery 读能力随 P1 就位。

## 二、已核实的 API 事实(零猜测)

### ctx.sessionQuery:SessionQueryEngine(@deepseek-ai/dsh-session-query@0.1.1-rc.2)

- `listSessions(signal?): Promise<SessionRecord[]>` — newest-first,`{ header, live, persisted }`
- `readSession(sessionId): Promise<SessionLogSnapshot>` — `{ session: SessionHeader, events: SessionEvent[] }`,replay 校验后的完整日志,**live/persisted 通吃且不需要 search 后端**
- `filterSessions(filters, signal?)`
- `readTitle(sessionId)`(标题折叠)
- 导出 `extractSessionEventText`:官方事件→文本提取器,P1 直接复用
- bonus:引擎带血缘追踪类型(`SessionLineageTrace`:ancestors + descendants 树),P3 的家谱查询未来白嫖
- 配置现实:`session-query-sqlite` 默认 `openAt: never`,search 类调用会报错,但 base patch 注释明示 exact reads/titles/traces 常开——**我们的工具只走 exact 面,不碰 search**

### ctx.storage(@deepseek-ai/dsh-storage@0.1.1-rc.2,backend.d.ts)

- 底面 `KvFacet.open({ name, version, tables, hasGlobal })` → `KvUnit.loadAll()/upsert(...)`,原子且 durable
- ⚠️ 待补一块:hub 服务面(`ctx.storage` 上注册 owner spec 的确切方法)需读该包 `index.d.ts` 后续确认——不影响血缘层数据模型先行

### ctx.workspaceRegistry(packages/workspace/workspace/src/index.ts,源码亲验)

- `create(path: string, title?: string): Promise<Workspace>` — path 非目录即抛错;新记录插入持久化 registry 头部
- `resolveByPath(path)` / 异常类 `WorkspaceUnknownSessionError` 等
- 归属:web profile 组合必然提供(Web 侧栏工作区列表由它驱动);headless 不保证

## 三、架构决策

### A1 血缘数据模型(storage 不可用时的降级也定义好)

```
unit: dsh_worktree_lineage (version 1)
tables:
  edges: key = worktree 绝对路径(规范化 POSIX 分隔)
         value = {
           parentPath: string|null     // git 主仓路径;null=自身即主仓
           branch: string              // 该 worktree 所检出的分支
           origin: 'plugin'|'inferred' // plugin=fork_project 登记;inferred=git 反推
           createdAt: number           // epoch ms
         }
global: { version: 1 }
```

归组判定双轨:
1. **edges 表命中** → 权威
2. 未命中 → git 反推兜底:worktree/.git 是文件,内容 `gitdir: <主仓>/.git/worktrees/<name>` → 解出主仓路径,推断 origin=inferred 缓存入表。**历史手工建的 worktree 也能自动归组**

主仓自身也入表(parentPath=null),保证视图两轨一致。

### A2 依赖声明策略:窄 inject + 运行时惰性解析

风险:cordis `inject` 若声明了组合中不存在的服务(fiber 永久等待)= 插件整个挂不上。`storage`/`workspaceRegistry` 是否每个 profile 都有未证实。

决策:
- 入口 `inject` 维持 `['tools']`(P0 已实证可用)
- P1/P2 工具 execute 内惰性解析 `(ctx as unknown as {...}).sessionQuery` 等,缺席时报人类可读错误("当前 profile 未提供 sessionQuery/web 层服务")
- 【待验证】cordis 是否有 optional-inject 惯用法(开写时查 cordis-primer 十分钟);若有则升级声明式,无则维持惰性方案
- TS 体验不受损:import 两 rc 包仅作 type-only 模块增强

### A3 工具清单与命名

| 工具 | 参数 | 返回(JSON)/render |
| --- | --- | --- |
| `session_list` | `limit?`(默认 20)、`cwdContains?`(按工作目录筛) | `{ total, sessions: [{id,title?,cwd,live,persisted}] }`;render 表格行 |
| `session_read` | `sessionId` 必填、`mode: 'tail'\|'full'`(默认 tail)、`maxChars?(默认 12000)` | `{ header, eventCount, text }`;text 经 extractSessionEventText |
| `project_fork` | `sourceRepoPath` 必填、`name` 必填(分支/目录尾段)、`parentDir?`(默认 sourceRepoPath 兄弟目录)、`baseRef?`、`title?` | `{ worktreePath, branch, workspaceRegistered, registryError? }` |

`project_fork` 动作链与回滚语义:
1. `git worktree add`(复用 P0 内部逻辑,**不走模型工具层**,提取 `src/git.ts` 为共享库)
2. 成功后 `workspaceRegistry.create(newPath, title ?? name)`;此步失败**不回滚** worktree(git 数据无损),返回半成功结果并附 registryError——保守优先,不做链式拆除
3. 血缘 edge 写入(upsert);血缘写入失败仅降级提示,不使整次调用失败

### A4 分组语义澄清(需求边界,防做歪)

- 「项目」= git 主仓(commondir 所有者),一个项目下挂 N 个 worktree + 它自己是第一个成员
- `project_fork` 显式登记血缘;其余入口(CLI 手工建的)靠 git 反推自动进组
- 非 git 目录、裸仓不参与分组;多级嵌套不存在(worktree 平铺一层,组=父项目)

## 四、测试与验收

框架:node:test(node22 自带,零新增依赖)+ 一个 smoke 脚本跑临时 fixture 仓库。

| 用例 | 覆盖 |
| --- | --- |
| lineage 反推:plugin 登记路径 | 单测,mock 存储落内存 map 即可(接口收窄便于 mock) |
| lineage 反推:gitdir 解析 | fixture:temp 主仓 + temp worktree(.git 文件各平台换行差异覆盖 \r\n) |
| project_fork 快乐路径 | fixture repo:create 断言目录存在、branch 正确、registry mock 记录调用 |
| project_fork 半失败 | registry mock 抛错 → 返回体含 registryError 且 worktree 保留 |
| session_read 截断 | maxChars 生效、tail 模式取尾部 |
| 回归:P0 三工具 | 现有 node 冒烟纳入 npm test |

真机验收(老大协作):dsh web 会话里喊三句话——列出最近会话/读取某会话尾部/fork 出新项目并看到侧栏出现新工作区。

## 五、风险与开放验证点

| # | 点 | 状态 | 兜底 |
| --- | --- | --- | --- |
| 1 | storage hub 服务面精确 API(index.d.ts) | 开写 Phase B 首步确认 | 数据模型不变,接口适配局限一文件 |
| 2 | cordis optional-inject | 开写时查 primer | 惰性解析(A2 已定) |
| 3 | openAt never 下 readSession 真机可用 | 老大真机验 | 报错信息会指明 SESSION_QUERY_SEARCH_DISABLED 区分 |
| 4 | rc 版 API 漂移 | 版本锁 0.1.1-rc.2(type-only dep) | 升级时只改类型层 |

## 六、执行序

B(血缘层)→ A(重构共享 git 库)→ P1 两工具 → P2 一工具 → 测试齐 → README 更新 → 真机验收清单交付老大。
