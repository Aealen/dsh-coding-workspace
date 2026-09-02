/**
 * 资源管理器写操作(重命名/删除)与服务端辅助。
 *
 * 安全边界:调用方必须先把入口路径过 resolveWithin(root)(越界拒绝),
 * 这里只负责「动作本身」的白名单:重命名新名单段校验(含 Windows 保留名)、
 * 同目录查重、删除递归 + force 吸收竞态。open/reveal 的系统调用在
 * panel-routes 路由层,spawn 无 shell、路径为单参数,无注入面。
 */
import { rename, rm, access } from 'node:fs/promises'
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
