/**
 * 独立于 DSH 运行时的最小行为测试：模拟 Session.append 与 Cordis 的 waterfall 调用。
 * 运行：node test/run.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function makeSession(id = 'session-a') {
  const log = []
  return {
    id,
    log,
    append(type, data, opts) {
      const event = { type, data, seq: log.length, time: Date.now(), ...(opts ?? {}) }
      log.push(event)
      return event
    },
  }
}

function makeCtx() {
  const listeners = new Map()
  const info = []
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
    },
    logger: {
      info(message) {
        info.push(message)
      },
      warn(message) {
        info.push(`WARN ${message}`)
      },
    },
  }
  return { ctx, listeners, info }
}

/** Build one durable attempt with the given streamed output. */
function attempt(turn, step, { reasoning, text, tools } = {}) {
  const now = Date.now()
  const stream = []
  let index = 0
  if (reasoning) stream.push({ type: 'reasoning-chunks', time0: now, index: index++, dt: [1], texts: [reasoning] })
  if (text) stream.push({ type: 'text-chunks', time0: now, index: index++, dt: [1], texts: [text] })
  for (const tool of tools ?? []) {
    stream.push({ type: 'tool-call-chunks', time0: now, index: index++, dt: [1], id: tool.id, name: tool.name, args: [tool.args] })
  }
  stream.push({ type: 'chunk', time: now, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'terminated', code: 'TRANSPORT' } } } })
  return { type: 'assistant/attempt', data: { turn, step, stream } }
}

function pushAttempt(session, turn, step, parts) {
  const event = attempt(turn, step, parts)
  event.seq = session.log.length
  session.log.push(event)
  return event
}

async function fire(listeners, name, payload) {
  const listener = listeners.get(name)
  assert.ok(listener, `listener ${name} registered`)
  return listener(payload, async () => ({ kind: 'enter', messages: [] }))
}

const failurePayload = (session, failure = { code: 'TRANSPORT', message: 'terminated' }, extra = {}) => ({
  agent: { session },
  turn: 1,
  step: 1,
  failure,
  signal: { aborted: false },
  ...extra,
})

async function testFailureInjection() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, { reasoning: 'A'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  const resume = session.log.find((event) => event.type === 'user/message')
  assert.ok(resume, 'resume message appended')
  assert.equal(resume.surfaceOp, 'append')
  assert.equal(resume.data.source.kind, 'thinking-resume')
  assert.ok(resume.data.content[0].text.includes('A'.repeat(300)), 'reasoning preserved verbatim')
  assert.ok(resume.data.content[0].text.includes('【中断续接】'), 'resume header present')
  assert.ok(resume.data.content[0].text.includes('TRANSPORT'), 'failure code stated')
  assert.ok(resume.data.content[0].text.includes('── 中断前的思考 ──'), 'reasoning section titled for a reader')
  assert.ok(resume.data.content[0].text.includes('对用户是这次中断留下的现场'), 'framing addresses the user too')
  assert.ok(resume.data.source.summary.startsWith('输出中断（TRANSPORT）：思考 300 字'), 'summary names the saved output')
  assert.ok(resume.data.source.summary.endsWith('」'), 'summary previews where generation stopped')
  assert.ok(resume.data.source.summary.length <= 120, 'summary stays inside the one-line bound')
}

async function testShortOutputKeptForReading() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, { minChars: 500 })
  pushAttempt(session, 1, 1, { reasoning: '短思考，但也是失败前已经产生的输出。' })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  const resume = session.log.find((event) => event.type === 'user/message')
  assert.ok(resume, 'short output is still saved for the reader')
  const body = resume.data.content[0].text
  assert.ok(body.includes('【中断留存】'), 'kept output is marked as not resumed')
  assert.ok(body.includes('短思考，但也是失败前已经产生的输出。'), 'short content preserved')
  assert.ok(body.includes('不要接着往下写'), 'keep variant forbids continuing')
  assert.ok(resume.data.source.summary.startsWith('已留存（TRANSPORT）'), 'summary marks a keep record')
}

async function testEmptyAttemptWritesNothing() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, {})
  await fire(listeners, 'agent/request-error', failurePayload(session))
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 0, 'no output, no card')
}

async function testKeepFloorSkipsEmptyNoise() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, { minChars: 500, keepMinChars: 100 })
  pushAttempt(session, 1, 1, { reasoning: '只有几十个字' })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 0, 'below the keep floor nothing is written')
}

async function testExcludedCodeIsKeptNotResumed() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, { reasoning: 'B'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session, { code: 'CONTEXT_WINDOW_EXCEEDED' }))
  const resume = session.log.find((event) => event.type === 'user/message')
  assert.ok(resume, 'an excluded failure is still saved for the reader')
  assert.ok(resume.data.content[0].text.includes('【中断留存】'), 'kept, not resumed')
  assert.ok(resume.data.content[0].text.includes('B'.repeat(300)), 'the thinking survives')
  assert.ok(!resume.data.content[0].text.includes('请从最后一个字符处紧接着继续生成'), 'no resume instruction')
}

async function testExcludedCodeCanSkipSaving() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, { keepOnExcluded: false })
  pushAttempt(session, 1, 1, { reasoning: 'B'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session, { code: 'AUTH' }))
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 0, 'opt-out keeps the old behaviour')
}

async function testRepeatedFailuresAccumulate() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 2, 3, { reasoning: 'C'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session, undefined, { turn: 2, step: 3 }))
  pushAttempt(session, 2, 3, { reasoning: 'D'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session, undefined, { turn: 2, step: 3 }))
  const resumes = session.log.filter((event) => event.type === 'user/message')
  assert.equal(resumes.length, 2, 'each failure carries its own delta')
  assert.ok(resumes[0].data.content[0].text.includes('C'.repeat(300)))
  assert.ok(resumes[1].data.content[0].text.includes('D'.repeat(300)))
  assert.ok(resumes[1].data.content[0].text.includes('第 2 次中断续接'))
}

async function testTextOnly() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, { text: '已经写出了一半的答复。'.repeat(30) })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  const resume = session.log.find((event) => event.type === 'user/message')
  assert.ok(resume, 'text-only attempt is resumed')
  const body = resume.data.content[0].text
  assert.ok(body.includes('── 中断前已输出的正文 ──'), 'text section present')
  assert.ok(body.includes('已经写出了一半的答复。'), 'text preserved')
  assert.ok(!body.includes('中断前的思考 ──'), 'no empty reasoning section')
  assert.ok(session.log.find((event) => event.type === 'user/message').data.source.summary.startsWith('输出中断（TRANSPORT）：正文 330 字'), 'summary counts only the text section')
}

async function testToolDraft() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, {
    reasoning: '需要读取文件。'.repeat(30),
    tools: [{ id: 'call_1', name: 'read_file', args: '{"path":"src/index.js"}' }],
  })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  const body = session.log.find((event) => event.type === 'user/message').data.content[0].text
  assert.ok(body.includes('── 已发起但未执行的工具调用 ──'), 'tool section present')
  assert.ok(body.includes('read_file'), 'tool name preserved')
  assert.ok(body.includes('{"path":"src/index.js"}'), 'tool arguments preserved')
  assert.ok(body.indexOf('中断前的思考') < body.indexOf('工具调用'), 'sections follow stream order')
}

async function testTailClampKeepsTextAndTools() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxInjectChars: 120 })
  pushAttempt(session, 1, 1, {
    reasoning: 'OLD'.repeat(100) + 'NEW'.repeat(100),
    text: 'TAILTEXT',
    tools: [{ id: 'call_9', name: 'write_file', args: '{"path":"b"}' }],
  })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  const body = session.log.find((event) => event.type === 'user/message').data.content[0].text
  assert.ok(body.includes('TAILTEXT'), 'newest text retained')
  assert.ok(body.includes('write_file'), 'newest tool retained')
  assert.ok(!body.includes('OLD'), 'oldest reasoning trimmed first')
  assert.ok(body.includes('NEW'), 'newest reasoning retained')
  assert.ok(body.includes('本节过长，只保留中断前最后'), 'trim notice present')
}

async function testLargeCountsAndBoundedSummary() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, {
    reasoning: '想'.repeat(3200),
    text: '这是一段很长的正文，'.repeat(40),
    tools: [
      { id: 'call_1', name: 'bash', args: '{"command":"ls"}' },
      { id: 'call_2', name: 'read', args: '{"path":"a"}' },
    ],
  })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  const summary = session.log.find((event) => event.type === 'user/message').data.source.summary
  assert.ok(summary.includes('思考 3.2k 字'), 'large reasoning counts compact to k')
  assert.ok(summary.includes('工具草稿 2 个'), 'tool draft count reported')
  assert.ok(summary.length <= 120, 'summary never exceeds the one-line bound')
}

async function testAbortedSignalSkipped() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, { reasoning: 'E'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session, undefined, { signal: { aborted: true } }))
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 0)
}

async function testPreStepOrphanRecovery() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  session.log.push({ type: 'user/message', data: { source: { kind: 'user' } } })
  pushAttempt(session, 4, 2, { reasoning: 'F'.repeat(300), text: '草稿正文' })
  const decision = await fire(listeners, 'agent/pre-step', { agent: { session }, turn: 5, step: 1 })
  const resume = decision.messages.find((message) => message?.source?.kind === 'thinking-resume')
  assert.ok(resume, 'resume queued for new turn')
  assert.ok(resume.content[0].text.includes('F'.repeat(300)))
  assert.ok(resume.content[0].text.includes('草稿正文'))
  assert.ok(resume.source.summary.startsWith('输出中断：'), 'recovery without a failure omits the error code')
  assert.ok(resume.source.summary.includes('思考 300 字'), 'recovery summary still reports the sections')
}

async function testPreStepSkipsSettled() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 4, 2, { reasoning: 'G'.repeat(300) })
  session.log.push({ type: 'assistant/message', data: { turn: 4, step: 2 } })
  const decision = await fire(listeners, 'agent/pre-step', { agent: { session }, turn: 5, step: 1 })
  assert.equal(decision.messages.length, 0, 'settled tail needs no recovery')
}

async function testPreStepAfterResume() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 4, 2, { reasoning: 'H'.repeat(300) })
  const first = await fire(listeners, 'agent/pre-step', { agent: { session }, turn: 5, step: 1 })
  assert.equal(first.messages.length, 1)
  // The loop admits the queued message into the surface.
  session.log.push({ type: 'user/message', data: first.messages[0], surfaceOp: 'append' })
  const second = await fire(listeners, 'agent/pre-step', { agent: { session }, turn: 6, step: 1 })
  assert.equal(second.messages.length, 0, 'already resumed attempts are not repeated')
}

await testFailureInjection()
await testShortOutputKeptForReading()
await testKeepFloorSkipsEmptyNoise()
await testEmptyAttemptWritesNothing()
await testExcludedCodeIsKeptNotResumed()
await testExcludedCodeCanSkipSaving()
await testRepeatedFailuresAccumulate()
await testTextOnly()
await testToolDraft()
await testTailClampKeepsTextAndTools()
await testLargeCountsAndBoundedSummary()
await testAbortedSignalSkipped()
await testPreStepOrphanRecovery()
await testPreStepSkipsSettled()
await testPreStepAfterResume()
console.log('all thinking-resume tests passed')
