import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'

/** 一条会话级血缘边:fork 产生的子会话指向其源会话。 */
export interface SessionLineageEdge {
  /** 源会话 id。 */
  sourceId: string
  /** 交接模式:full=完整复制前缀(内核 fork);focus=摘要种子。 */
  mode: 'full' | 'focus'
  /** 子会话继承的工作目录(便于分组视图归位)。 */
  cwd?: string
  /** 登记时间(epoch ms)。 */
  createdAt: number
}

export interface SessionLineageFile {
  version: 1
  edges: Record<string, SessionLineageEdge>
}

export const SESSION_LINEAGE_FILE_VERSION = 1

export interface SessionLineageStore {
  readAll(): Promise<Record<string, SessionLineageEdge>>
  writeEdge(childId: string, edge: SessionLineageEdge): Promise<void>
  /** 按源会话反查全部子会话边。 */
  childrenOf(sourceId: string): Promise<Record<string, SessionLineageEdge>>
  removeEdge(childId: string): Promise<boolean>
}

/** harness home 下的 session-lineage.json,原子写(与 worktree-lineage.json 同款纪律)。 */
export function createFileSessionLineageStore(homeDir: string = defaultDshHome()): SessionLineageStore {
  const file = join(homeDir, 'session-lineage.json')

  async function readEdges(): Promise<Record<string, SessionLineageEdge>> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SessionLineageFile>
      if (parsed.version !== SESSION_LINEAGE_FILE_VERSION || typeof parsed.edges !== 'object' || parsed.edges === null) {
        return {}
      }
      return parsed.edges
    } catch {
      return {}
    }
  }

  async function writeEdges(edges: Record<string, SessionLineageEdge>): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(
      tmp,
      JSON.stringify({ version: SESSION_LINEAGE_FILE_VERSION, edges } satisfies SessionLineageFile, null, 2),
      'utf8',
    )
    await rename(tmp, file)
  }

  return {
    async readAll() {
      return readEdges()
    },
    async writeEdge(childId, edge) {
      const edges = await readEdges()
      edges[childId] = edge
      await writeEdges(edges)
    },
    async childrenOf(sourceId) {
      const edges = await readEdges()
      const out: Record<string, SessionLineageEdge> = {}
      for (const [childId, edge] of Object.entries(edges)) {
        if (edge.sourceId === sourceId) out[childId] = edge
      }
      return out
    },
    async removeEdge(childId) {
      const edges = await readEdges()
      if (!(childId in edges)) return false
      delete edges[childId]
      await writeEdges(edges)
      return true
    },
  }
}
