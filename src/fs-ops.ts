/**
 * 资源管理器写操作(重命名/删除)与服务端辅助。
 *
 * 安全边界:调用方必须先把入口路径过 resolveWithin(root)(越界拒绝),
 * 这里只负责「动作本身」的白名单:重命名新名单段校验(含 Windows 保留名)、
 * 同目录查重、删除递归 + force 吸收竞态。open/reveal 的系统调用在
 * panel-routes 路由层,spawn 无 shell、路径为单参数,无注入面。
 */
import { rename, rm, access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Windows 保留设备名(不区分大小写,带扩展名形式同样保留)。 */
const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/** Windows 文件名非法字符(: 引入盘符/流,通配符在 win32 API 层面拒绝)。 */
const WIN_ILLEGAL = /[:*?"<>|]/

/**
 * 重命名新名校验:非空、无首尾空白、单段(不含 / \)、非 . ..、
 * 无控制字符、无 Windows 非法字符、非 Windows 保留名。
 * 合法原样返回;非法返回 null。
 */
export function validateNewName(name: string): string | null {
  if (name === '' || name !== name.trim()) return null
  if (name === '.' || name === '..') return null
  if (name.includes('/') || name.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return null
  if (WIN_ILLEGAL.test(name)) return null
  const stem = name.replace(/\.[^.]*$/, '')
  if (WIN_RESERVED.has(stem.toUpperCase())) return null
  return name
}

/** 绝对路径拼接:root + POSIX 斜杠相对路径;空段防御,输出按平台分隔符。 */
export function joinAbs(root: string, rel: string): string {
  const segments = rel.split('/').filter((seg) => seg !== '' && seg !== '.')
  return join(root, ...segments)
}

/** 同目录重命名:目标已存在抛错(node rename 在 win32 覆盖已存在文件,须先行查重)。 */
export async function renameEntry(dirAbs: string, oldName: string, newName: string): Promise<void> {
  const to = join(dirAbs, newName)
  try {
    await access(to)
  } catch {
    await rename(join(dirAbs, oldName), to)
    return
  }
  throw new Error(`重命名失败:目标「${newName}」已存在`)
}

/** 删除文件或目录树(目录递归);force 吸收 ENOENT 竞态(重复删除/并行变更)。 */
export async function deleteEntry(abs: string, isDir: boolean): Promise<void> {
  await rm(abs, { recursive: isDir, force: true })
}

// ---------------------------------------------------------------------------
// 文件编辑器读写支持:大小上限、二进制/编码探测。
// ---------------------------------------------------------------------------

/** 编辑器读写单文件字节上限(2MB;编辑场景是源码/文本,超限提示走系统打开)。 */
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024

/**
 * 二进制内容探测:NUL 字节必二进制;非空白控制字符占比 > 2% 判二进制
 * (UTF-16/EXE/图片等形态,文本文件几乎不出现)。BOM 与 \t \n \r 不计。
 */
export function isLikelyBinary(buf: Buffer): boolean {
  const n = buf.length
  if (n === 0) return false
  let suspicious = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) suspicious++
  }
  return suspicious / n > 0.02
}

/**
 * 文本解码:strict utf8 解码成功(无替换字符)原文返回;
 * 出现 U+FFFD 或解码失败返回 null(调用方提示不支持编辑)。
 */
export function encodeTextFile(buf: Buffer): string | null {
  try {
    const text = buf.toString('utf8')
    return text.includes('�') ? null : text
  } catch {
    return null
  }
}

/**
 * 原子写:先写同目录临时文件再 rename 覆盖,避免半写损坏原文件
 * (编辑器保存路径)。失败时清理临时文件;rename 覆盖已存在目标是本函数的意图。
 */
export async function atomicWriteFile(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.dshw-tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, abs)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
