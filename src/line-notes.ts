/**
 * 行评论(编辑器行级 Note for AI):纯数据层 + 文件存储。
 *
 * 用户新增/编辑/删除,并可把评论以「File/Line/User comment」格式贴到指定会话
 * 输入框。存储沿用 changelist 的 sidecar 模式:harness home 下
 * coding-workspace-line-notes.json,per (cwd+相对路径归一 key) 一份评论列表。
 * 行号是用户落笔时的位置,文件后续编辑不跟随(v1 接受,便签语义)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 一条行评论:id 为生成序号(创建后不变,编辑只改 text)。 */
export interface LineNote {
  id: string
  /** 1 起行号。 */
  line: number
  text: string
  createdAt: number
}

export interface LineNotesState {
  /** key = noteKey(cwd, relPath)。 */
  byFile: Record<string, LineNote[]>
}

export const EMPTY_NOTES: LineNotesState = { byFile: {} }

const FILE_VERSION = 1

let seq = 0

/** 存储键:cwd+相对路径统一正斜杠(与 changelistKey 同约定)。 */
export function noteKey(cwd: string, relPath: string): string {
  return `${cwd.trim().replace(/\\/g, '/')} ${relPath.trim().replace(/\\/g, '/')}`
}

/** 追加评论:空文本/行号 < 1 拒绝(返回原引用)。 */
export function addNote(state: LineNotesState, key: string, line: number, text: string): LineNotesState {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!Number.isInteger(line) || line < 1 || trimmed === '') return state
  const note: LineNote = { id: `note-${++seq}`, line, text: trimmed, createdAt: Date.now() }
  const list = state.byFile[key] ?? []
  return { byFile: { ...state.byFile, [key]: [...list, note] } }
}

/** 改文本:不存在/空文本返回原引用。 */
export function updateNote(state: LineNotesState, key: string, id: string, text: string): LineNotesState {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const list = state.byFile[key]
  if (list === undefined || trimmed === '' || !list.some((n) => n.id === id)) return state
  return { byFile: { ...state.byFile, [key]: list.map((n) => (n.id === id ? { ...n, text: trimmed } : n)) } }
}

/** 删评论;文件清单空了自然清 key。不存在返回原引用。 */
export function deleteNote(state: LineNotesState, key: string, id: string): LineNotesState {
  const list = state.byFile[key]
  if (list === undefined || !list.some((n) => n.id === id)) return state
  const next = list.filter((n) => n.id !== id)
  const byFile = { ...state.byFile }
  if (next.length === 0) delete byFile[key]
  else byFile[key] = next
  return { byFile }
}

/** 取某文件的评论(按创建序,无记录返回空数组)。 */
export function notesForFile(state: LineNotesState, key: string): LineNote[] {
  return state.byFile[key] ?? []
}

/**
 * 文件存储:整个 state 单文件(JSON {version, byFile}),读写全量。
 * 写入走临时文件 + rename(与 changelist store 同款原子替换)。
 */
export function createLineNotesStore(file: string): {
  readAll(): Promise<LineNotesState>
  writeAll(state: LineNotesState): Promise<void>
} {
  const readAll = async (): Promise<LineNotesState> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return EMPTY_NOTES
    }
    try {
      const parsed = JSON.parse(raw) as { version?: number; byFile?: Record<string, LineNote[]> }
      if (parsed.version !== FILE_VERSION || typeof parsed.byFile !== 'object' || parsed.byFile === null) {
        return EMPTY_NOTES
      }
      return { byFile: parsed.byFile }
    } catch {
      return EMPTY_NOTES // 半截/损坏文件按空表处理
    }
  }
  const writeAll = async (state: LineNotesState): Promise<void> => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, byFile: state.byFile }, null, 2), 'utf8')
    await rename(tmp, file)
  }
  return { readAll, writeAll }
}
