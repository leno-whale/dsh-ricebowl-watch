/**
 * state.js 的用例：原子写、坏 JSON 兜底、seen 上限、pending 幂等。
 * 临时目录放包内 `.tmp/`，用完删掉（不往系统别处写东西）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAX_SEEN,
  addPending,
  defaultState,
  planBaseline,
  planFresh,
  readState,
  sanitizeState,
  writeState,
} from '../lib/state.js'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TMP = path.join(PKG, '.tmp')

function tmpDir(t, name) {
  const dir = path.join(TMP, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('原子写：落盘后内容可读，且不留 .tmp', (t) => {
  const dir = tmpDir(t, 'state-write')
  const file = path.join(dir, 'state.json')
  writeState(file, { ...defaultState(), sinceComments: '2026-10-25T09:06:32Z', seen: [1, 2], baselined: true })

  assert.equal(fs.existsSync(file), true)
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'tmp 必须被 rename 掉，不能留在磁盘上')

  const back = readState(file)
  assert.equal(back.sinceComments, '2026-10-25T09:06:32Z')
  assert.deepEqual(back.seen, [1, 2])
  assert.equal(back.baselined, true)
})

test('目录不存在时自动创建（首次运行）', (t) => {
  const dir = tmpDir(t, 'state-mkdir')
  const file = path.join(dir, 'a', 'b', 'state.json')
  writeState(file, defaultState())
  assert.equal(fs.existsSync(file), true)
})

test('读到坏 JSON / 半截 JSON / 空文件 → 回落默认值，不抛', (t) => {
  const dir = tmpDir(t, 'state-broken')
  const file = path.join(dir, 'state.json')

  fs.writeFileSync(file, '{not json', 'utf8')
  assert.deepEqual(readState(file), defaultState(), '写坏了就当没状态')

  fs.writeFileSync(file, '{"sinceComments":"2026-10-25T09:06:32Z","seen":[1,2', 'utf8')
  assert.deepEqual(readState(file), defaultState(), '半截 JSON（正好在写的时候被拔电）不能抛')

  fs.writeFileSync(file, '', 'utf8')
  assert.deepEqual(readState(file), defaultState())

  assert.deepEqual(readState(path.join(dir, 'nope.json')), defaultState(), '文件不存在也要能跑')

  // 半截 JSON 不该让插件崩溃，但也不该假装自己是 baselined —— 否则历史会被倒出来。
  assert.equal(readState(file).baselined, false)
})

test('sanitizeState 会洗掉脏数据', () => {
  assert.equal(sanitizeState(null), null)
  assert.equal(sanitizeState([]), null)
  const dirty = sanitizeState({
    sinceComments: 123,
    seen: [1, '2', 'x', -3, 0, 2],
    pending: [{ id: 5, kind: 'weird', body: null }, { nope: true }],
    baselined: 'yes',
  })
  assert.deepEqual(dirty.seen, [1, 2], 'id 去重、非法值丢掉')
  assert.equal(dirty.pending.length, 1)
  assert.equal(dirty.pending[0].kind, 'comment', 'kind 只认 issue/comment')
  assert.equal(dirty.baselined, false, 'baselined 只认真正的 true')
})

test('seen 最多 800 条，保留最新的', () => {
  const seen = Array.from({ length: 900 }, (_, i) => i + 1)
  const st = sanitizeState({ ...defaultState(), seen })
  assert.equal(st.seen.length, MAX_SEEN)
  assert.equal(st.seen[0], 101)
  assert.equal(st.seen.at(-1), 900)
})

test('addPending 同一个 id 只加一次', () => {
  const one = { id: 7, kind: 'comment', body: 'a' }
  const first = addPending([], [one])
  assert.equal(first.pending.length, 1)
  const second = addPending(first.pending, [{ ...one, body: 'b' }])
  assert.equal(second.pending.length, 1, 'id 相同就不再进')
  assert.equal(second.pending[0].body, 'a')
  assert.equal(second.added, 0)
})

test('planFresh 幂等：同一批评论喂两轮，pending 只加一次', () => {
  const comments = [
    { id: 11, created_at: '2026-10-25T10:00:00Z', issue_url: 'https://api.github.com/repos/o/r/issues/7', user: { login: 'a' }, body: '你好' },
  ]
  const base = { ...defaultState(), baselined: true, sinceComments: '2026-10-25T09:00:00Z' }

  const round1 = planFresh(base, { comments, login: 'me' })
  assert.equal(round1.fresh.length, 1)
  assert.equal(round1.state.pending.length, 1)
  assert.equal(round1.state.pending[0].no, 7, '从 issue_url 里取出帖号')
  assert.equal(round1.state.sinceComments, '2026-10-25T10:00:00Z', 'since 推进到本轮最新（服务器时间）')

  const round2 = planFresh(round1.state, { comments, login: 'me' })
  assert.equal(round2.fresh.length, 0, '第二轮不能再算新')
  assert.equal(round2.state.pending.length, 1, 'pending 也不该变多')
})

test('没拉到新评论时 since 保持原值（不用本机时钟，C7）', () => {
  const base = { ...defaultState(), baselined: true, sinceComments: '2026-10-25T09:00:00Z' }
  const { state } = planFresh(base, { comments: [], issues: [], login: '' })
  assert.equal(state.sinceComments, '2026-10-25T09:00:00Z')
})

test('planBaseline 不动已有 pending，只补 seen 和开帖游标', () => {
  const old = { ...defaultState(), pending: [{ id: 3, kind: 'comment' }] }
  const st = planBaseline(old, {
    comments: [{ id: 1, created_at: '2026-10-20T00:00:00Z' }],
    issues: [{ id: 2, created_at: '2026-10-21T00:00:00Z' }],
    newestAt: '2026-10-25T09:06:32Z',
  })
  assert.equal(st.pending.length, 0, '基线态本来就不该有 pending')
  assert.equal(st.seen.length, 1, 'seen 只记评论 id')
  assert.equal(st.sinceIssues, '2026-10-21T00:00:00Z', '开帖游标取最新开帖的时间')
  assert.equal(st.baselined, true)
})

test('回归（P1）：seen 被评论挤爆后，老开帖不能重新变成新帖', () => {
  // 基线时仓库里有 3 个老开帖。
  const issues = [80, 81, 82].map((number, i) => ({
    id: 900 + i,
    number,
    created_at: `2026-10-0${i + 1}T00:00:00Z`,
    title: `老帖 ${number}`,
    body: `正文 ${number}`,
    html_url: `https://github.com/o/r/issues/${number}`,
    user: { login: 'a' },
  }))
  let state = planBaseline(defaultState(), { comments: [], issues, newestAt: '2026-10-03T00:00:00Z' })
  assert.equal(state.pending.length, 0)

  // 之后 9 轮、每轮 100 条新评论（共 900 条，足够把 seen 的 800 条上限挤爆），
  // 每轮都把同样 3 个老开帖再喂一遍——这就是审阅时复现的那个第 9 轮。
  for (let round = 0; round < 9; round += 1) {
    const comments = Array.from({ length: 100 }, (_, i) => {
      const id = 10_000 + round * 100 + i
      return {
        id,
        created_at: new Date(Date.UTC(2026, 9, 4, 0, round, i)).toISOString(),
        issue_url: 'https://api.github.com/repos/o/r/issues/80',
        body: `回音 ${id}`,
        user: { login: 'b' },
      }
    })
    const { state: next, fresh } = planFresh(state, { comments, issues, login: 'me' })
    assert.equal(fresh.filter((x) => x.kind === 'issue').length, 0, `第 ${round + 1} 轮：老开帖不该被当新帖重投`)
    state = next
  }
  assert.equal(state.seen.length, MAX_SEEN, 'seen 确实被挤到了上限，回归场景是真的')
  assert.equal(state.sinceIssues, '2026-10-03T00:00:00Z', '没有新开帖时游标不动')
})
