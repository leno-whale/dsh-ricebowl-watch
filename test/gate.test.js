/**
 * gate.js 的用例：闸的三种状态（不变 / 变了 / 文件不存在），外加「只动 mtime 不算变」。
 * 时间用注入的假时钟，不 sleep、不联网。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createGate, findSessionFile, tailFingerprint } from '../lib/gate.js'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TMP = path.join(PKG, '.tmp')

function tmpDir(t, name) {
  const dir = path.join(TMP, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function setup(t, { idleMs = 120_000, content = 'hello world', withFile = true } = {}) {
  const home = tmpDir(t, 'gate')
  const sessionDir = path.join(home, 'sessions', '--C-Users-x--', 'bili-whale')
  fs.mkdirSync(sessionDir, { recursive: true })
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  if (withFile) fs.writeFileSync(file, content, 'utf8')

  let clock = 1_000_000
  const logs = []
  const gate = createGate({
    sessionId: 'bili-whale',
    idleMs,
    home,
    log: (m) => logs.push(m),
    now: () => clock,
  })
  return { gate, file, logs, home, advance: (ms) => { clock += ms }, now: () => clock }
}

test('文件不变：建闸时就记了指纹，第一次不白等 idleMs，之后也不递减', (t) => {
  const { gate, advance } = setup(t)
  assert.equal(gate.remainMs(), 0, '建闸时已经记过指纹，第一次就该放行')
  advance(1_000)
  assert.equal(gate.remainMs(), 0)
  advance(60_000)
  assert.equal(gate.remainMs(), 0, '一直没人写会话文件，就一直放行')
})

test('尾部变了：重新计时到 idleMs', (t) => {
  const { gate, file, advance } = setup(t)
  assert.equal(gate.remainMs(), 0)

  fs.appendFileSync(file, '\n又聊了一句', 'utf8')
  advance(1_000)
  assert.equal(gate.remainMs(), 120_000, '有人刚写会话文件 → 闸重置')

  advance(30_000)
  assert.equal(gate.remainMs(), 90_000)
})

test('只动 mtime、内容没变 → 不算有人说话（这就是不用 mtime 的原因）', (t) => {
  const { gate, file, advance } = setup(t)
  assert.equal(gate.remainMs(), 0)

  const future = new Date(Date.now() + 3_600_000)
  fs.utimesSync(file, future, future)
  advance(1_000)
  assert.equal(gate.remainMs(), 0, 'harness 定期冲盘会碰 mtime，不能因此重置')

  // 长度没变、内容变了：sha1 变了，仍然要算「说了话」。
  fs.writeFileSync(file, 'hello worlD', 'utf8')
  advance(1_000)
  assert.equal(gate.remainMs(), 120_000)
})

test('建闸后才出现会话文件 → 从出现那一刻开始计时', (t) => {
  const { home } = setup(t, { withFile: false })
  const gate2 = createGate({ sessionId: 'bili-whale', idleMs: 120_000, home, log: () => {}, now: () => 2_000_000 })
  assert.equal(gate2.remainMs(), 0, '没有文件时放行')

  const dir = path.join(home, 'sessions', '--C-Users-x--', 'bili-whale')
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), '第一句', 'utf8')
  assert.equal(gate2.remainMs(), 120_000, '刚出现的文件就是刚有人说话')
})

test('会话文件不存在 → 放行（返回 0），并且只记一次日志', (t) => {
  const { gate, logs } = setup(t, { withFile: false })
  assert.equal(gate.remainMs(), 0)
  assert.equal(gate.remainMs(), 0)
  assert.equal(logs.length, 1, '找不到文件不该每轮刷日志')
  assert.match(logs[0], /没找到会话文件/)
})

test('tailFingerprint：size + 尾 4KB 的 sha1', (t) => {
  const dir = tmpDir(t, 'fp')
  const file = path.join(dir, 'f.bin')
  fs.writeFileSync(file, 'abcdef', 'utf8')
  const fp1 = tailFingerprint(file)
  assert.match(fp1, /^6:[0-9a-f]{12}$/)
  fs.writeFileSync(file, 'abcdef', 'utf8')
  assert.equal(tailFingerprint(file), fp1, '内容没变指纹就不变')
  fs.appendFileSync(file, 'g', 'utf8')
  assert.notEqual(tailFingerprint(file), fp1)
})

test('findSessionFile：逐层找 sessions/<cwd>/<sessionId>/session.v4*', (t) => {
  const dir = tmpDir(t, 'find')
  const sessionDir = path.join(dir, 'sessions', '--F-agent~0020expore--', 'bili-whale')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')

  const found = findSessionFile({ home: dir, sessionId: 'bili-whale' })
  assert.equal(found, path.join(sessionDir, 'session.v4.jsonl.zstd'))
  assert.equal(findSessionFile({ home: dir, sessionId: 'nobody' }), '')
  assert.equal(findSessionFile({ home: path.join(dir, 'nope'), sessionId: 'bili-whale' }), '')
})
