/**
 * 分栏 Diff 行对齐纯函数(无 DOM 依赖,node --test 可直测)。
 *
 * 输入左右两份文本,输出「行对齐序列」:每行标 eq(两栏同有同行)/ del
 * (仅左栏,右栏空)/ add(仅右栏,左栏空),渲染层按 type 染色即可。
 *
 * 算法:公共前缀/后缀剥离(真实改动几乎总是局部的,剥完规模骤降)+
 * 小规模 LCS 全表 DP;剥后仍超预算时诚实降级为整块替换(全 del + 全 add),
 * 保证任何输入都有界输出,不卡 UI。
 */

/** 单行对齐结果:left/right 为各栏行号(1 起),null = 该栏无此行。 */
export interface DiffRow {
  left: number | null
  right: number | null
  type: 'eq' | 'del' | 'add'
  /** 行内容(eq 取左,del 取左,add 取右)。 */
  text: string
}

/** 对齐序列行数上限(超限截断,防御异常大输入撑爆 DOM)。 */
export const MAX_DIFF_ROWS = 20000

/** 剥离前后缀后允许走 LCS DP 的单元格预算(N×M;约 2000×2000,Int32 峰值 ~16MB 一次性)。 */
const DP_CELL_BUDGET = 4_000_000

/**
 * 文本按行拆分;CRLF/CR 先归一为 LF(Windows 工作区 autocrlf 检出的 CRLF 与
 * git blob 的 LF 必须等价对齐,否则逐行全不等退化成整块替换);末尾空段保留
 * (与 textarea 视觉行一致,'a\n' 是两行)。
 */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/** 行对齐主入口。 */
export function alignLines(leftText: string, rightText: string): DiffRow[] {
  const left = splitLines(leftText)
  const right = splitLines(rightText)

  // 公共前缀/后缀剥离:注意留量防重叠(左尾部越过右头部)
  let pre = 0
  const maxPre = Math.min(left.length, right.length)
  while (pre < maxPre && left[pre] === right[pre]) pre++
  let suf = 0
  const maxSuf = Math.min(left.length, right.length) - pre
  while (suf < maxSuf && left[left.length - 1 - suf] === right[right.length - 1 - suf]) suf++

  const midL = left.slice(pre, left.length - suf)
  const midR = right.slice(pre, right.length - suf)

  const rows: DiffRow[] = []
  let li = 0
  let ri = 0
  // 全局行号计数:li/ri 恒等于「已消费行数」,行号 = li+1 / ri+1,各分支共用
  const pushEq = (l: string): void => {
    rows.push({ left: li + 1, right: ri + 1, type: 'eq', text: l })
    li++
    ri++
  }

  for (let i = 0; i < pre; i++) pushEq(left[i])
  // 中段对齐
  if (midL.length === 0 && midR.length === 0) {
    // 全等,无中段
  } else if (midL.length === 0) {
    for (const text of midR) rows.push({ left: null, right: ++ri, type: 'add', text })
  } else if (midR.length === 0) {
    for (const text of midL) rows.push({ left: ++li, right: null, type: 'del', text })
  } else if (midL.length * midR.length <= DP_CELL_BUDGET) {
    for (const row of lcsAlign(midL, midR, li)) rows.push(row)
    li += midL.length
    ri += midR.length
  } else {
    // 降级:中段整体替换(诚实呈现,不假装对齐)
    for (const text of midL) rows.push({ left: ++li, right: null, type: 'del', text })
    for (const text of midR) rows.push({ left: null, right: ++ri, type: 'add', text })
  }
  for (let i = 0; i < suf; i++) {
    const l = left[left.length - suf + i]
    pushEq(l)
  }

  return rows.length > MAX_DIFF_ROWS ? rows.slice(0, MAX_DIFF_ROWS) : rows
}

/**
 * 中段 LCS 对齐(全表 DP,调用方已保证规模在预算内)。
 * 回溯产出 eq/del/add 序列;eq 行号按中段内相对位置 + 段前偏移。
 */
function lcsAlign(midL: readonly string[], midR: readonly string[], pre: number): DiffRow[] {
  const n = midL.length
  const m = midR.length
  // dp[i][j] = midL[i..] 与 midR[j..] 的 LCS 长度(滚动两行不足以回溯,存全表)
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    const rowOff = i * width
    const nextOff = (i + 1) * width
    for (let j = m - 1; j >= 0; j--) {
      dp[rowOff + j] =
        midL[i] === midR[j]
          ? dp[nextOff + j + 1] + 1
          : Math.max(dp[nextOff + j], dp[rowOff + j + 1])
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midL[i] === midR[j]) {
      rows.push({ left: pre + i + 1, right: pre + j + 1, type: 'eq', text: midL[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      rows.push({ left: pre + i + 1, right: null, type: 'del', text: midL[i] })
      i++
    } else {
      rows.push({ left: null, right: pre + j + 1, type: 'add', text: midR[j] })
      j++
    }
  }
  while (i < n) rows.push({ left: pre + i++ + 1, right: null, type: 'del', text: midL[i - 1] })
  while (j < m) rows.push({ left: null, right: pre + j++ + 1, type: 'add', text: midR[j - 1] })
  return rows
}

// ---------------------------------------------------------------------------
// 变更块分段与配对(渲染层「行指向连线 / 缩略状态列」的数据源)。
// ---------------------------------------------------------------------------

/** 连续 del/add 行聚成的块:行索引半开区间 [start, end)。 */
export interface DiffBlock {
  type: 'del' | 'add'
  start: number
  end: number
}

/** 配对块:del 与相邻 add 成对(IDEA 行指向连线两端);孤块对侧缺省。 */
export interface DiffBlockPair {
  del?: DiffBlock
  add?: DiffBlock
}

/** 聚块:连续同类型(非 eq)行为一块。 */
export function diffBlocks(rows: readonly DiffRow[]): DiffBlock[] {
  const blocks: DiffBlock[] = []
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].type
    if (t === 'eq') continue
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]
      if (last.type === t && last.end === i) {
        last.end = i + 1
        continue
      }
    }
    blocks.push({ type: t as 'del' | 'add', start: i, end: i + 1 })
  }
  return blocks
}

/**
 * 配对:相邻的 del 块与 add 块(中间无 eq 行隔开)连成一对;孤块自成一对、
 * 对侧缺省。alignLines 输出里 del 段总在 add 段前(LCS 回溯次序)。
 */
export function pairBlocks(blocks: readonly DiffBlock[]): DiffBlockPair[] {
  const pairs: DiffBlockPair[] = []
  for (const block of blocks) {
    const prev = pairs[pairs.length - 1]
    if (block.type === 'add' && prev !== undefined && prev.del !== undefined && prev.add === undefined && prev.del.end === block.start) {
      prev.add = block
      continue
    }
    pairs.push(block.type === 'del' ? { del: block } : { add: block })
  }
  return pairs
}
