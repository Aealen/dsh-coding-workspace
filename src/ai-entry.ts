/**
 * AI commit message 生成(Changes 页「AI 生成」按钮的后端):
 *
 * - 走宿主 LlmRuntime(`llm` 服务)流式调用,模型路由取用户当前默认选择
 *   (`agentDefaultModel.currentSelection()`),不引入任何额外 key 配置。
 * - 输入 = 所选文件的状态/路径 + 变更 diff(截断)+ 现有提交风格样例(git log %s)。
 * - cordis 消息构造对齐官方 dsh-session-title-llm 样板(createUserMessage 内联,
 *   不新增 dsh-llm 依赖 —— adapter 只认消息形状,类型面无需该包)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { runGit } from './git.js'
import { isSafeRepoPath } from './panel-git.js'
import { createKnownPaths } from './tools/known-paths.js'

/** 读取请求体 JSON;失败返回空对象(与 panel-routes 同款)。 */
function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

export const name = 'dsh-coding-workspace-ai'

/**
 * 依赖 llm/agentDefaultModel(headless 等组合缺席时本 entry 自动缺席,
 * 不拖累 panel 组路由);webServer 为 HTTP 注册面。
 */
export const inject = ['llm', 'agentDefaultModel', 'webServer']

/** 输入预算:diff 截断字节 / 风格样例条数 / 超时。 */
const DIFF_MAX_BYTES = 24_000
const PER_FILE_MAX_BYTES = 4_000
const STYLE_SAMPLE_COUNT = 20
const TIMEOUT_MS = 60_000

export function apply(ctx: Context): void {
  const { assertKnown } = createKnownPaths(ctx)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-coding-workspace/ai-commit-msg',
        handler: async (req, res) => {
          const body = await readBody(req)
          const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
          const files = Array.isArray(body?.files)
            ? (body.files as unknown[]).filter(
                (f): f is { path: string; status: string } =>
                  typeof (f as any)?.path === 'string' &&
                  typeof (f as any)?.status === 'string' &&
                  isSafeRepoPath((f as any).path),
              )
            : []
          if (cwd === '') return json(res, 400, { ok: false, message: '缺少 cwd' })
          if (files.length === 0) return json(res, 400, { ok: false, message: '缺少所选文件' })
          try {
            const repo = await assertKnown(cwd)
            const tracked = files.filter((f) => f.status !== '??').map((f) => f.path)
            const untracked = files.filter((f) => f.status === '??').map((f) => f.path)

            // 变更内容:tracked 走 diff HEAD(含 staged);untracked 读文件头部(新文件全景)
            const parts: string[] = []
            if (tracked.length > 0) {
              parts.push(truncate(await runGit(repo, ['diff', 'HEAD', '--', ...tracked]).catch(() => ''), DIFF_MAX_BYTES))
            }
            for (const p of untracked.slice(0, 10)) {
              const head = await readHead(repo, p)
              parts.push(truncate(`--- 新文件:${p}\n${head}`, PER_FILE_MAX_BYTES))
            }
            const diff = parts.join('\n\n').slice(0, DIFF_MAX_BYTES)
            const styles = (await runGit(repo, ['log', `-n`, String(STYLE_SAMPLE_COUNT), '--pretty=format:%s']).catch(() => ''))
              .split(/\r?\n/)
              .filter((s) => s.trim() !== '')
              .slice(0, STYLE_SAMPLE_COUNT)

            const selection = (ctx.agentDefaultModel as { currentSelection?: () => { provider: string; model: string } } | undefined)
              ?.currentSelection?.()
            if (selection === undefined || selection?.provider === undefined) {
              return json(res, 400, { ok: false, message: '宿主未配置默认模型' })
            }

            const prompt = [
              `以下是本次要提交的变更(状态与 diff 摘要):\n${diff || '(无可展示的 diff)'}`,
              styles.length > 0 ? `参考本仓库现有提交风格:\n${styles.map((s) => `- ${s}`).join('\n')}` : '',
              '请为这些变更生成一条 git commit message:遵循上面的现有风格(类型前缀/语言/详略),只输出 message 本身,不要引号、不要 markdown、不要解释。',
            ]
              .filter(Boolean)
              .join('\n\n')

            const message = await generate(ctx, selection, prompt)
            json(res, 200, { ok: true, message })
          } catch (error) {
            json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-coding-workspace: ai-commit-msg route',
  )
}

/** 一次流式调用,攒 text-delta;finish 异常/无文本时抛错(对齐 session-title-llm 语义)。 */
async function generate(ctx: Context, selection: { provider: string; model: string }, prompt: string): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  // createUserMessage 内联(dsh-llm 该构造为纯形状工厂,无运行时依赖必要)
  const messages = [
    {
      id: `dshw-ai-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: name },
    },
  ]
  let text = ''
  let failure: string | undefined
  for await (const chunk of ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    messages,
    system: '你是 git commit message 生成器。只输出 message 本身:单行、无引号、无 markdown、无解释。',
    signal,
  })) {
    if (signal.aborted) throw new Error('AI 生成超时')
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind !== 'stop') {
      failure = chunk.reason.failure?.message ?? `模型调用终止:${chunk.reason.kind}`
    }
  }
  if (failure !== undefined) throw new Error(failure)
  const cleaned = text.trim().split('\n')[0]?.trim() ?? ''
  if (cleaned === '') throw new Error('模型未返回文本')
  return cleaned.slice(0, 200)
}

/** 读新文件头部(untracked 无 diff 可用;失败返回空串,不阻塞生成)。 */
async function readHead(repo: string, relPath: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const raw = await readFile(join(repo, relPath), 'utf8')
    return raw.split(/\r?\n/).slice(0, 100).join('\n')
  } catch {
    return ''
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(已截断)` : text
}

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
