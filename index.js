/**
 * dsh-thinking-resume — 保住中断前的输出，断点续接。
 *
 * DSH 在模型请求失败时会把已收到的流落成一条非表面的 `assistant/attempt`
 * 事件（reasoning、正文、工具调用草稿都在里面）；重试请求按表面历史重建，
 * 所以这段已经生成的内容不会回到模型眼前，模型只能从头再产一遍。本插件在
 * 失败发生时把 attempt 里的流式输出整理成一条表面 user 消息（source.kind =
 * thinking-resume，UI 显示为上下文卡片）写回会话，使随后的重试请求带着断点
 * 继续，而不是白手起家。
 *
 * 另在用户于失败后重新发消息（例如 DSH 重启/换天继续）时，由 `agent/pre-step`
 * 把最后一段未被接续的失败输出补进新 turn，避免它永远沉在日志里。
 */
import { randomUUID } from 'node:crypto'

/** Source kind of the injected context message; also the marker used to avoid reinjection. */
const SOURCE_KIND = 'thinking-resume'
const TAG = 'thinking-resume'

/** Failures that are not transient interruptions; resuming them wastes context. */
const DEFAULT_EXCLUDE_CODES = [
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'INVALID_REQUEST',
  'NO_ADAPTER',
  'CONTEXT_WINDOW_EXCEEDED',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_REASONING_EFFORT',
  'IMAGE_OFFLOAD_REQUIRED',
]

/** Defaults; this profile links local bundles, so the package carries no Schemastery dependency. */
const DEFAULT_CONFIG = {
  enabled: true,
  minChars: 200,
  maxInjectChars: 0,
  recoverOnResume: true,
  excludeCodes: DEFAULT_EXCLUDE_CODES,
  logLevel: 'info',
}

/**
 * Collect every kind of model output already streamed before the failure.
 *
 * Compact runs (reasoning/text/tool-call chunks) carry the deltas; `block-end`
 * records repeat them, so a block is used only when its run is absent (an
 * adapter that emits a whole block without deltas). Tool calls are drafts that
 * never executed, because the loop dispatches tools only after a successful
 * finish.
 * @param attempt - durable `assistant/attempt` event, when found.
 * @returns reasoning text, visible text, and started tool calls in block order.
 */
function streamParts(attempt) {
  const stream = attempt?.data?.stream
  const parts = { reasoning: '', text: '', tools: [] }
  if (!Array.isArray(stream)) return parts
  const runs = []
  for (const record of stream) {
    if (record?.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
      runs.push({ index: record.index ?? 0, kind: 'reasoning', text: record.texts.join(''), fromDelta: true })
    } else if (record?.type === 'text-chunks' && Array.isArray(record.texts)) {
      runs.push({ index: record.index ?? 0, kind: 'text', text: record.texts.join(''), fromDelta: true })
    } else if (record?.type === 'tool-call-chunks') {
      runs.push({
        index: record.index ?? 0,
        kind: 'tool',
        id: record.id,
        name: record.name,
        text: Array.isArray(record.args) ? record.args.join('') : '',
        fromDelta: true,
      })
    } else if (record?.type === 'chunk' && record.chunk?.type === 'block-end') {
      const block = record.chunk.block
      if (block?.type === 'reasoning') {
        runs.push({ index: record.chunk.index ?? 0, kind: 'reasoning', text: block.text, fromDelta: false })
      } else if (block?.type === 'text') {
        runs.push({ index: record.chunk.index ?? 0, kind: 'text', text: block.text, fromDelta: false })
      } else if (block?.type === 'tool-call') {
        runs.push({ index: record.chunk.index ?? 0, kind: 'tool', id: block.id, name: block.name, text: block.arguments, fromDelta: false })
      }
    }
  }
  const deltaIndexes = new Set(runs.filter((run) => run.fromDelta).map((run) => `${run.kind}:${run.index}`))
  const kept = runs
    .filter((run) => run.fromDelta || !deltaIndexes.has(`${run.kind}:${run.index}`))
    .sort((a, b) => a.index - b.index)
  for (const run of kept) {
    if (run.kind === 'reasoning') parts.reasoning += run.text
    else if (run.kind === 'text') parts.text += run.text
    else parts.tools.push({ id: run.id, name: run.name, text: run.text })
  }
  return parts
}

/**
 * Total character weight of one attempt's streamed output.
 * @param parts - result of {@link streamParts}.
 * @returns reasoning + text + tool argument characters.
 */
function partsLength(parts) {
  return parts.reasoning.length + parts.text.length + parts.tools.reduce((sum, tool) => sum + tool.text.length, 0)
}

/**
 * Keep the tail of one oversized body without splitting a surrogate pair.
 * @param text - original text.
 * @param maxChars - positive limit; 0 or negative means no limit.
 * @returns the (possibly tail-trimmed) body and whether it was trimmed.
 */
function clampBody(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { body: text, trimmed: false }
  }
  let cut = text.length - Math.floor(maxChars)
  const code = text.charCodeAt(cut)
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1
  return { body: text.slice(cut), trimmed: true }
}

/**
 * Render the model-facing resume instruction around the preserved output.
 * Budget is allocated newest-first (tool drafts, then text, then reasoning),
 * because the interruption point always sits at the end of the stream.
 * @param options - parsed parts, budget, failure facts, and attempt number.
 * @returns the text of the injected user message.
 */
function buildResumeText({ parts, maxChars, failure, count }) {
  const toolLines = parts.tools.map((tool, index) => {
    const name = tool.name ? ` ${tool.name}` : ` tool#${index + 1}`
    return `-${name}${tool.id ? ` (${tool.id})` : ''}: ${tool.text || '{}'}`
  })
  const sections = []
  if (parts.reasoning) sections.push({ key: 'reasoning', title: '=== 内部思考（reasoning）===', body: parts.reasoning })
  if (parts.text) sections.push({ key: 'text', title: '=== 已输出的正文（text）===', body: parts.text })
  if (toolLines.length > 0) sections.push({ key: 'tools', title: '=== 已发起但尚未执行的工具调用 ===', body: toolLines.join('\n') })

  let budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Infinity
  const fitted = new Map()
  for (const key of ['tools', 'text', 'reasoning']) {
    const section = sections.find((candidate) => candidate.key === key)
    if (section === undefined) continue
    if (!Number.isFinite(budget)) {
      fitted.set(key, { body: section.body, trimmed: false })
      continue
    }
    if (section.body.length <= budget) {
      fitted.set(key, { body: section.body, trimmed: false })
      budget -= section.body.length
    } else {
      fitted.set(key, { body: clampBody(section.body, budget).body, trimmed: true })
      budget = 0
    }
  }

  const lines = [
    '【流式续接 / stream resume】',
    `上一次模型请求在你的输出进行到中途时中断（${failure?.code ?? 'ERROR'}${failure?.message ? `：${failure.message}` : ''}）。`,
    '下面是你中断前已经产生的流式输出原文，由 DSH 插件自动保存并在此接续；它不是用户的新指令，也不是要复述的内容。',
  ]
  if (count > 1) lines.splice(1, 0, `（这是本次请求的第 ${count} 次中断续接）`)
  for (const section of sections) {
    const kept = fitted.get(section.key)
    lines.push('')
    lines.push(section.title)
    if (kept.trimmed) lines.push(`（本节过长，只保留中断前最后 ${kept.body.length} 字符）`)
    lines.push(kept.body)
  }
  lines.push('')
  lines.push('请从最后一个字符处紧接着继续生成：不要重复已经输出的内容，不要从头开始。若已经可以得出结论，直接继续正文或发起工具调用。')
  return lines.join('\n')
}

/**
 * Find the durable attempt settlement for one failed step.
 * @param session - agent session whose log is the source of truth.
 * @param turn - failed turn.
 * @param step - failed step.
 * @returns the newest matching `assistant/attempt`, or undefined when there is none.
 */
function findFailedAttempt(session, turn, step) {
  const log = session?.log
  if (!Array.isArray(log)) return undefined
  const floor = Math.max(0, log.length - 600)
  for (let i = log.length - 1; i >= floor; i -= 1) {
    const event = log[i]
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      if (event.data?.turn === turn && event.data?.step === step) return undefined
      continue
    }
    if (event.type !== 'assistant/attempt') continue
    const at = event.data?.turn
    const st = event.data?.step
    if (at === turn && st === step) return event
    if (typeof at === 'number' && (at < turn || (at === turn && typeof st === 'number' && st < step))) return undefined
  }
  return undefined
}

/**
 * Find the last attempt in the log that no later surface message answered or resumed.
 * Used when a new turn starts after a failure ended the previous one.
 * @param session - agent session.
 * @returns the attempt event, or undefined when the tail is settled.
 */
function findOrphanAttempt(session) {
  const log = session?.log
  if (!Array.isArray(log)) return undefined
  const floor = Math.max(0, log.length - 600)
  for (let i = log.length - 1; i >= floor; i -= 1) {
    const event = log[i]
    if (event === undefined) continue
    if (event.type === 'assistant/message') return undefined
    if (event.type === 'user/message') {
      const source = event.data?.source
      // A resume message already carries the interrupted output into this surface.
      if (source?.kind === SOURCE_KIND) return undefined
      continue
    }
    if (event.type !== 'assistant/attempt') continue
    return event
  }
  return undefined
}

/**
 * Whether any resume message already follows this attempt.
 * @param session - agent session.
 * @param attemptSeq - settlement position of the attempt.
 * @returns whether the attempt was already resumed.
 */
function alreadyResumed(session, attemptSeq) {
  const log = session?.log
  if (!Array.isArray(log)) return false
  for (let i = log.length - 1; i > attemptSeq && i >= 0; i -= 1) {
    const event = log[i]
    if (event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) return true
    if (event?.type === 'assistant/message') return true
  }
  return false
}

/**
 * Build one frozen surface user message carrying preserved output.
 * @param options - rendered text and the attempt facts it derives from.
 * @returns a durable user message ready for `Session.append`.
 */
function makeResumeMessage({ text, attemptSeq, turn, step, chars }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: SOURCE_KIND,
      form: 'notice',
      summary: `输出中断，已接续 ${chars} 字符`,
      attemptSeq,
      turn,
      step,
    }),
  })
}

/**
 * Install resume listeners for failed request attempts and orphaned recoveries.
 * @param ctx - plugin context owning the listeners.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const enabled = cfg.enabled !== false
  if (!enabled) {
    ctx.logger?.info?.(`${TAG}: disabled by config`)
    return
  }
  const minChars = Number.isFinite(cfg.minChars) ? Math.max(0, cfg.minChars) : 200
  const maxInjectChars = Number.isFinite(cfg.maxInjectChars) ? Math.max(0, cfg.maxInjectChars) : 0
  const recoverOnResume = cfg.recoverOnResume !== false
  const exclude = new Set(Array.isArray(cfg.excludeCodes) ? cfg.excludeCodes : DEFAULT_EXCLUDE_CODES)
  const verbose = cfg.logLevel !== 'silent'
  /** Counts per `session:turn:step` so repeated failures number their resume messages. */
  const counts = new Map()
  /** Settlement keys already injected, guarding against duplicate waterfall delivery. */
  const injected = new Set()

  const countKey = (session, turn, step) => `${String(session?.id ?? '')}:${turn}:${step}`
  const nextCount = (session, turn, step) => {
    const key = countKey(session, turn, step)
    const value = (counts.get(key) ?? 0) + 1
    counts.set(key, value)
    while (counts.size > 500) counts.delete(counts.keys().next().value)
    return value
  }

  /**
   * Append (or hand back) one resume message for a failed attempt.
   * @returns the message when it should enter a new turn, otherwise undefined.
   */
  function prepareResume({ session, turn, step, attempt, failure, deliver }) {
    const parts = streamParts(attempt)
    const total = partsLength(parts)
    if (total < minChars) return undefined
    const settlement = `${String(session.id)}:${attempt.seq}`
    if (injected.has(settlement)) return undefined
    injected.add(settlement)
    while (injected.size > 500) injected.delete(injected.values().next().value)
    // A queued resume is not in the surface yet; keep it from being produced twice.
    if (!deliver && alreadyResumed(session, attempt.seq)) return undefined
    const count = nextCount(session, turn, step)
    const text = buildResumeText({ parts, maxChars: maxInjectChars, failure, count })
    const message = makeResumeMessage({ text, attemptSeq: attempt.seq, turn, step, chars: total })
    if (deliver) {
      session.append('user/message', message, { surfaceOp: 'append' })
      verbose && ctx.logger?.info?.(`${TAG}: resumed turn=${turn} step=${step} chars=${total} code=${failure?.code ?? '?'}`)
      return undefined
    }
    verbose && ctx.logger?.info?.(`${TAG}: queued resume for next turn=${turn} step=${step} chars=${total}`)
    return message
  }

  // Prepend: the retry executor may own the decision without calling next(),
  // so the resume message must be committed before that listener runs.
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      const { agent, turn, step, failure, signal } = payload ?? {}
      const session = agent?.session
      if (session && signal?.aborted !== true) {
        const code = typeof failure?.code === 'string' ? failure.code : ''
        if (!exclude.has(code)) {
          const attempt = findFailedAttempt(session, turn, step)
          if (attempt !== undefined) prepareResume({ session, turn, step, attempt, failure, deliver: true })
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`${TAG}: resume after failure failed: ${String(error)}`)
    }
    return next()
  }, true)

  if (recoverOnResume) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'enter') return decision
        const { agent, turn } = payload ?? {}
        const session = agent?.session
        if (!session) return decision
        const attempt = findOrphanAttempt(session)
        if (attempt === undefined) return decision
        if (alreadyResumed(session, attempt.seq)) return decision
        const message = prepareResume({
          session,
          turn: attempt.data?.turn ?? turn,
          step: attempt.data?.step ?? 0,
          attempt,
          failure: undefined,
          deliver: false,
        })
        if (message === undefined) return decision
        return { ...decision, messages: [message, ...decision.messages] }
      } catch (error) {
        ctx.logger?.warn?.(`${TAG}: resume before new turn failed: ${String(error)}`)
        return decision
      }
    })
  }

  verbose && ctx.logger?.info?.(`${TAG}: active (minChars=${minChars}, recoverOnResume=${recoverOnResume})`)
}
