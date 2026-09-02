/**
 * 面板文案出口:client entry 装配时 installLocale(宿主 ctx.locale),
 * 组件统一调 t(key, params)。宿主 locale 服务缺席时兜底直查 zh 字典
 * (纯 headless/旧宿主组合不炸 slot,文案退中文)。
 *
 * 切语言重渲染由宿主负责:slot 出口自带 useLocaleRevision(切语言整树
 * 重渲染),bind 的 t 调用时读活跃语言,无需自订订阅。
 */
import { EN, LOCALE_NS, ZH, type Translate } from './locales.js'

let bound: Translate | null = null
let disposeDict: (() => void) | null = null

/** 兜底 t:zh 优先、en 补位、key 显形(fail loud,与宿主查找链同精神)。 */
const fallback: Translate = (key, params) => {
  let text = ZH[key] ?? EN[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v))
  }
  return text
}

/**
 * 注册字典并 bind t。幂等:HMR/重载会二次 apply,直接 register 会撞
 * 「already has locale」——先落上一轮的注册,再注册新版;register 失败
 * 不影响 bind(字典已在宿主里)。任一步失败都退兜底,面板不因 i18n 挂掉。
 */
export function installLocale(locale: unknown): void {
  const runtime = locale as {
    register?: (ns: string, dicts: unknown) => (() => void) | undefined
    bind?: (ns: string) => Translate
  } | undefined
  if (runtime?.register === undefined || runtime?.bind === undefined) {
    console.warn('[dsh-coding-workspace] i18n: locale runtime unavailable', typeof locale)
    return
  }
  try {
    disposeDict?.()
  } catch {
    /* 旧注册已失效:忽略 */
  }
  disposeDict = null
  try {
    const off = runtime.register(LOCALE_NS, { zh: ZH, en: EN })
    disposeDict = typeof off === 'function' ? off : null
  } catch (error) {
    /* 同 ns 重复注册(HMR):字典已在,继续 bind */
    console.warn('[dsh-coding-workspace] i18n: register skipped', error instanceof Error ? error.message : error)
  }
  try {
    const fn = runtime.bind(LOCALE_NS)
    if (typeof fn === 'function') bound = fn
  } catch (error) {
    bound = null
    console.warn('[dsh-coding-workspace] i18n: bind failed', error instanceof Error ? error.message : error)
  }
}

/** 面板文案出口(全组件共用;identity 稳定,可安全用于渲染路径)。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const fn = bound ?? fallback
  try {
    return fn(key, params)
  } catch {
    return fallback(key, params)
  }
}
