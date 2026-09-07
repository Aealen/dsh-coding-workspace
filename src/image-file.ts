/**
 * 图片预览支持(前后端共用,纯函数无 node 依赖):
 * 扩展名白名单判定 + MIME 推断。前端 openFile 用 isImagePath 决定 image 视图,
 * 服务端 fs-raw 路由用 contentTypeOf 决定响应头(双保险:URL 直打非图片 400)。
 */

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] as const

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

function extOf(relPath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(relPath.trim())
  return m === null ? '' : m[1].toLowerCase()
}

/** 图片文件判定(按扩展名;路径来自 TAB relPath / 路由 path,均已归一)。 */
export function isImagePath(relPath: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, extOf(relPath))
}

/** 扩展名 → MIME;非白名单返回 null(路由据此拒绝)。 */
export function contentTypeOf(relPath: string): string | null {
  return MIME_BY_EXT[extOf(relPath)] ?? null
}
