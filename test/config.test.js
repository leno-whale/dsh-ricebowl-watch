/**
 * config.js 的用例：三源合并（config > env > 默认）、非法值回落、越界夹紧、login 回退。
 *
 * 这组是为了钉死一个真踩过的坑：`Number('')` 是 0，如果不先判空，
 * 没配的 maxPages 会被「夹到下限」变成 1（翻页只拉第一页），pollMs 变成 10 秒。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, readToken, readTokenFile, resolveConfig } from '../lib/config.js'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TMP = path.join(PKG, '.tmp')

function tmpDir(t, name) {
  const dir = path.join(TMP, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('什么都不配 → 全部默认值（尤其 maxPages=10、pollMs=60000）', () => {
  const cfg = resolveConfig({}, { env: {} })
  assert.equal(cfg.repo, 'pianVei/rice-bowl')
  assert.equal(cfg.sessionId, 'ricebowl-watch')
  assert.equal(cfg.pollMs, 60_000)
  assert.equal(cfg.bootMs, 30_000)
  assert.equal(cfg.idleMs, 120_000)
  assert.equal(cfg.digestChars, 50)
  assert.equal(cfg.digestMax, 8)
  assert.equal(cfg.maxPages, 10, '默认必须真的是 10，不是被夹到 1')
  assert.equal(cfg.logMaxBytes, 1_048_576)
  assert.equal(cfg.cwd, path.join(os.homedir(), '.dsh'), '~ 要展开')
  assert.equal(cfg.tokenFile, path.join(os.homedir(), '.dsh', 'github-token.json'), 'token 文件默认在新家')
  assert.equal(Object.keys(cfg).includes('token'), false, '配置对象里不许带 token')
})

test('环境变量能改，config 对象能盖过环境变量', () => {
  const fromEnv = resolveConfig({}, { env: { RICE_WATCH_POLL_MS: '90000', RICE_WATCH_MAX_PAGES: '3' } })
  assert.equal(fromEnv.pollMs, 90_000)
  assert.equal(fromEnv.maxPages, 3)

  const fromConfig = resolveConfig(
    { pollMs: 45000, maxPages: 2 },
    { env: { RICE_WATCH_POLL_MS: '90000', RICE_WATCH_MAX_PAGES: '3' } },
  )
  assert.equal(fromConfig.pollMs, 45_000, '显式配置 > 环境变量')
  assert.equal(fromConfig.maxPages, 2)
})

test('非法值回落默认，越界值夹到边界（不报错、不拒启）', () => {
  const cfg = resolveConfig(
    {
      pollMs: 'abc',
      bootMs: -5,
      digestChars: '10',
      digestMax: '99',
      maxPages: '999',
      idleMs: '1000',
    },
    { env: {} },
  )
  assert.equal(cfg.pollMs, 60_000, '不是数字 → 默认')
  assert.equal(cfg.bootMs, 0, '负的 bootMs 夹到 0（起来就看一次）')
  assert.equal(cfg.digestChars, 20, '低于下限 20 → 夹到 20')
  assert.equal(cfg.digestMax, 50, '高于上限 50 → 夹到 50')
  assert.equal(cfg.maxPages, 30, '翻页上限 30')
  assert.equal(cfg.idleMs, 1000)
})

test('repo 写错回落默认，sessionId / cwd 可覆盖', () => {
  assert.equal(resolveConfig({ repo: 'not-a-repo' }, { env: {} }).repo, 'pianVei/rice-bowl')
  assert.equal(resolveConfig({ repo: 'a/b' }, { env: {} }).repo, 'a/b')
  const cfg = resolveConfig({ sessionId: 'my-session', cwd: 'D:\\work' }, { env: {} })
  assert.equal(cfg.sessionId, 'my-session')
  assert.equal(cfg.cwd, 'D:\\work')
})

test('login 默认取 token 文件的 username；读不到就是空（全放行，不误杀）', (t) => {
  const dir = tmpDir(t, 'cfg')
  const file = path.join(dir, 'github.json')
  fs.writeFileSync(file, JSON.stringify({ token: 't'.repeat(40), username: 'leno-whale' }), 'utf8')

  assert.equal(readTokenFile(file).username, 'leno-whale')
  assert.equal(resolveConfig({ tokenFile: file }, { env: {}, candidates: [] }).login, 'leno-whale')
  assert.equal(resolveConfig({ tokenFile: file, login: 'other' }, { env: {}, candidates: [] }).login, 'other')
  assert.equal(resolveConfig({ tokenFile: path.join(dir, 'nope.json') }, { env: {}, candidates: [] }).login, '')
  // 不传 candidates 时会去试真实的候选文件（这台机器上有），所以只断言「不抛、是字符串」
  assert.equal(typeof resolveConfig({ tokenFile: path.join(dir, 'nope.json') }, { env: {} }).login, 'string')
})

test('token 候选文件：配置的那个读不到，就依次试候选（缺文件不抛）', (t) => {
  const dir = tmpDir(t, 'cfg-cand')
  const alt = path.join(dir, 'github.json')
  fs.writeFileSync(alt, JSON.stringify({ token: 'c'.repeat(40), username: 'leno-whale' }), 'utf8')

  const got = readToken({ tokenFile: path.join(dir, 'nope.json'), env: {}, candidates: [alt] })
  assert.equal(got.token, 'c'.repeat(40), '第一个读不到就试下一个')
  assert.ok(got.source.endsWith('github.json'), 'source 要指出是从哪个文件来的')

  const none = readToken({ tokenFile: path.join(dir, 'nope.json'), env: {}, candidates: [path.join(dir, 'x.json')] })
  assert.deepEqual(none, { token: '', username: '', source: '' }, '全都没有就是空，不抛')
})

test('token 文件坏掉 / 字段缺失都不抛，只返回空', (t) => {
  const dir = tmpDir(t, 'cfg-bad')
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{oops', 'utf8')
  assert.deepEqual(readTokenFile(bad), { token: '', username: '' })

  const alt = path.join(dir, 'alt.json')
  fs.writeFileSync(alt, JSON.stringify({ 'benzi-game token': 'b'.repeat(40) }), 'utf8')
  assert.equal(readTokenFile(alt).token.length, 40, '上一代用的字段也要认')
  assert.equal(readTokenFile(path.join(dir, 'none.json')).token, '')
})

test('token 来源：GITHUB_TOKEN 优先，其次 tokenFile', (t) => {
  const dir = tmpDir(t, 'cfg-token')
  const file = path.join(dir, 'github.json')
  fs.writeFileSync(file, JSON.stringify({ token: 'file-token', username: 'leno-whale' }), 'utf8')

  const envWin = readToken({ tokenFile: file, env: { GITHUB_TOKEN: 'env-token' }, candidates: [] })
  assert.equal(envWin.token, 'env-token', '环境变量优先（CI 不用建文件）')
  assert.equal(envWin.source, 'GITHUB_TOKEN')
  assert.equal(envWin.username, 'leno-whale', 'username 仍可以从文件里取')

  const fileWin = readToken({ tokenFile: file, env: {}, candidates: [] })
  assert.equal(fileWin.token, 'file-token')
  assert.ok(fileWin.source.endsWith('github.json'), `source 要说清从哪来（拿到 ${fileWin.source}）`)

  const none = readToken({ tokenFile: path.join(dir, 'nope.json'), env: {}, candidates: [] })
  assert.equal(none.token, '')
  assert.equal(none.source, '')
})

test('默认值表本身是第 5 节那张表', () => {
  assert.deepEqual(DEFAULTS, {
    repo: 'pianVei/rice-bowl',
    tokenFile: '~/.dsh/github-token.json',
    login: '',
    sessionId: 'ricebowl-watch',
    deliverTo: '',
    idleSession: '',
    mentionNames: 'leno-whale',
    cwd: '~/.dsh',
    pollMs: 60_000,
    bootMs: 30_000,
    idleMs: 120_000,
    digestChars: 50,
    digestMax: 8,
    maxPages: 10,
    logMaxBytes: 1_048_576,
    activeWindows: '12:00-14:00,18:00-24:00',
    weekendAllDay: true,
    sleepPollMs: 900_000,
    callWakeMaxPerDay: 3,
    burstMax: 5,
    burstMs: 600_000,
    afterUserMs: 600_000,
  })
})

test('投递目标与空闲闸：默认跟着 sessionId，配一个 deliverTo 就两个都跟着它', () => {
  const plain = resolveConfig({}, { env: {}, candidates: [] })
  assert.equal(plain.deliverTo, 'ricebowl-watch')
  assert.equal(plain.idleSession, 'ricebowl-watch')

  const one = resolveConfig({ deliverTo: 'bili-whale' }, { env: {}, candidates: [] })
  assert.equal(one.deliverTo, 'bili-whale', '消息落到聊天的会话')
  assert.equal(one.idleSession, 'bili-whale', '闸要盯同一个会话，否则永远放行')

  const both = resolveConfig({ deliverTo: 'a', idleSession: 'b' }, { env: {}, candidates: [] })
  assert.equal(both.deliverTo, 'a')
  assert.equal(both.idleSession, 'b', '两个也可以分开指')

  const legacy = resolveConfig({ sessionId: 'old' }, { env: {}, candidates: [] })
  assert.equal(legacy.deliverTo, 'old', '老配置只写 sessionId 仍然生效')
})

test('提到我的名字：默认是 leno-whale，可改成多个', () => {
  assert.deepEqual(resolveConfig({}, { env: {}, candidates: [] }).mentions, ['leno-whale'])
  assert.deepEqual(
    resolveConfig({ mentionNames: 'Leno-Whale, 肥鱼' }, { env: {}, candidates: [] }).mentions,
    ['leno-whale', '肥鱼'],
  )
})
