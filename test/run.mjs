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
  assert.ok(resume.data.content[0].text.includes('流式续接'), 'resume header present')
  assert.ok(resume.data.source.summary.includes('300'), 'summary reports character count')
}

async function testMinChars() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, { minChars: 500 })
  pushAttempt(session, 1, 1, { reasoning: 'short reasoning' })
  await fire(listeners, 'agent/request-error', failurePayload(session))
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 0)
}

async function testExcludeCodes() {
  const session = makeSession()
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  pushAttempt(session, 1, 1, { reasoning: 'B'.repeat(300) })
  await fire(listeners, 'agent/request-error', failurePayload(session, { code: 'AUTH' }))
  assert.equal(session.log.filter((event) => event.type === 'user/message').length, 0)
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
  assert.ok(body.includes('=== 已输出的正文（text）==='), 'text section present')
  assert.ok(body.includes('已经写出了一半的答复。'), 'text preserved')
  assert.ok(!body.includes('内部思考'), 'no empty reasoning section')
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
  assert.ok(body.includes('=== 已发起但尚未执行的工具调用 ==='), 'tool section present')
  assert.ok(body.includes('read_file'), 'tool name preserved')
  assert.ok(body.includes('{"path":"src/index.js"}'), 'tool arguments preserved')
  assert.ok(body.indexOf('内部思考') < body.indexOf('工具调用'), 'sections follow stream order')
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
await testMinChars()
await testExcludeCodes()
await testRepeatedFailuresAccumulate()
await testTextOnly()
await testToolDraft()
await testTailClampKeepsTextAndTools()
await testAbortedSignalSkipped()
await testPreStepOrphanRecovery()
await testPreStepSkipsSettled()
await testPreStepAfterResume()
console.log('all thinking-resume tests passed')
