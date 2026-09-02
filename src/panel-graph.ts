/**
 * git log 拓扑图布局(纯函数,零依赖 —— 客户端 bundle 直引,服务端 re-export):
 *
 * 由 parents 序列自建 lane 拓扑,替代 git --graph ASCII 的半步字符模型
 * (ASCII 斜线一行只移半格,几何天生断裂;IDEA 风格需要全局固定 lane 网格 + 平滑曲线)。
 */

/** 一条边:行内从 fromLane 画到 toLane(相等即竖直直线,不等即换 lane 弧线),color 为调色板索引。 */
export interface GraphEdge {
  from: number
  to: number
  color: number
}

/** 一行的布局:commit 点所在 lane(root 之外的收尾行 lane 为 null)+ 本行要画的边。 */
export interface GraphRowLayout {
  lane: number | null
  color: number
  edges: GraphEdge[]
}

export interface GraphLayout {
  /** 用到的最大 lane 数(前端据此定 SVG 宽)。 */
  laneCount: number
  /** 与 commits 等长;列表截断导致 lane 仍 active 时,末尾追加一条收尾行(lane=null)。 */
  rows: GraphRowLayout[]
}

interface LaneSlot {
  /** 该 lane 当前等待的 commit hash;null = 槽位已释放。 */
  tip: string | null
  color: number
}

/**
 * lane 分配(gitgraph 系通用算法,IDEA/gitk 同款思路):
 *
 * - commit 到来时认领「等待它」的 lane;无人等待则取第一个空槽,否则尾部扩容。
 * - first parent 无主则继承当前 lane;其余 parent 无主则开新 lane,有主则并入。
 * - 弧线颜色沿用源 lane(分支线生到死一色,IDEA 同款);lane 释放后槽位可复用。
 * - 输入须为同一 commit 序列(--date-order --all,含分页已加载的全量,纯函数重放成本可忽略)。
 */
export function buildGraphLayout(commits: { hash: string; parents: string[] }[]): GraphLayout {
  const rows: GraphRowLayout[] = []
  const lanes: (LaneSlot | null)[] = []
  let colorSeq = 0
  let laneCount = 1

  const acquire = (): number => {
    const free = lanes.findIndex((l) => l === null)
    if (free !== -1) {
      lanes[free] = { tip: null, color: colorSeq++ }
      return free
    }
    lanes.push({ tip: null, color: colorSeq++ })
    return lanes.length - 1
  }
  const findTip = (hash: string): number => lanes.findIndex((l) => l !== null && l.tip === hash)

  for (const commit of commits) {
    laneCount = Math.max(laneCount, lanes.length)
    const idx = findTip(commit.hash)
    const lane = idx !== -1 ? idx : acquire()
    const myColor = lanes[lane]!.color
    laneCount = Math.max(laneCount, lane + 1)

    const edges: GraphEdge[] = []
    // 其余 active lane 穿行直线
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] !== null) edges.push({ from: j, to: j, color: lanes[j]!.color })
    }

    // first parent:有主则并入(弧线,源色),无主则继承当前 lane
    let consumed = false
    commit.parents.forEach((p, i) => {
      const target = findTip(p)
      if (target !== -1) {
        edges.push({ from: lane, to: target, color: myColor })
        return
      }
      if (i === 0) {
        lanes[lane] = { tip: p, color: myColor }
        edges.push({ from: lane, to: lane, color: myColor })
        consumed = true
        return
      }
      const slot = acquire()
      laneCount = Math.max(laneCount, slot + 1)
      lanes[slot]!.tip = p
      edges.push({ from: lane, to: slot, color: myColor })
    })
    if (!consumed && commit.parents.length === 0) lanes[lane] = null
    else if (!consumed) {
      // parents 全部并入已有 lane:当前 lane 释放
      lanes[lane] = null
    }
    rows.push({ lane, color: myColor, edges: edges.sort((a, b) => a.from - b.from) })
  }

  // 截断收尾:仍有 active lane 时补一条纯延续行(lane=null)
  const tail: GraphEdge[] = []
  for (let j = 0; j < lanes.length; j++) {
    if (lanes[j] !== null) tail.push({ from: j, to: j, color: lanes[j]!.color })
  }
  laneCount = Math.max(laneCount, lanes.length)
  if (tail.length > 0) rows.push({ lane: null, color: -1, edges: tail })

  return { laneCount, rows }
}
