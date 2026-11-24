/**
 * Temporary verification provider: emits reasoning, visible text, and a tool
 * call draft, then fails the first attempt with TRANSPORT. Every later attempt
 * succeeds, and each request is appended to /tmp/fake-resume-provider.log so
 * the caller can check whether the thinking-resume plugin put the preserved
 * output back into the request.
 */
import { appendFileSync } from 'node:fs'

const LOG = '/tmp/fake-resume-provider.log'
const MODEL = 'fake-1'
const REASONING = '第一步：确认失败发生在哪个阶段。第二步：检查滑点阈值与仓位。第三步：比较三套参数。'.repeat(10)
const TEXT = '正在整理结论：先把失败点定位在请求中断，而不是推理错误。'
const TOOL_ARGS = '{"path":"src/index.js"}'
let calls = 0

function note(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break the stream
  }
}

function userTexts(messages) {
  const texts = []
  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  return texts
}

const adapter = {
  providerInfo(provider) {
    return { id: provider, name: 'Fake resume provider' }
  },
  async listModels(provider) {
    return [{ provider, id: MODEL, name: 'Fake resume model', inputModalities: ['text'] }]
  },
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: 'Fake resume model',
      inputModalities: ['text'],
      context: { contextWindow: 200000 },
      defaultMaxTokens: 4096,
    }
  },
  providerRetryPolicy() {
    return undefined
  },
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => adapter.stream(options) }
  },
  async *stream(options) {
    calls += 1
    const attempt = calls
    const texts = userTexts(options.messages)
    const injected = texts.filter((text) => text.includes('流式续接'))
    const hasText = injected.some((text) => text.includes(TEXT))
    const hasTool = injected.some((text) => text.includes('read_file'))
    note(`request ${attempt} messages=${options.messages.length} resume-messages=${injected.length} chars=${injected[0]?.length ?? 0} text=${hasText} tool=${hasTool}`)
    if (attempt === 1) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (const part of REASONING.match(/.{1,18}/gu) ?? []) {
        yield { type: 'reasoning-delta', index: 0, text: part }
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: REASONING } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      for (const part of TEXT.match(/.{1,10}/gu) ?? []) {
        yield { type: 'text-delta', index: 1, text: part }
      }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: TEXT } }
      yield { type: 'block-start', index: 2, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 2, id: 'call_draft_1', name: 'read_file', argumentsDelta: TOOL_ARGS }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'simulated transport interruption', code: 'TRANSPORT' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '续接后的推理。' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '续接后的推理。' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: 'ok' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['fake-resume'], adapter)
  ctx.logger?.info?.('fake-resume-provider: registered fake-resume/fake-1')
}
