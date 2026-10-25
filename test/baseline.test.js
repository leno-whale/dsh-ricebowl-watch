/**
 * 首次基线的用例 —— 这个插件最严重的事故就是「装上第一秒把三年历史倒给你」，
 * 所以这一组必须死死钉住：基线只记 id、不产生 pending。
 *
 * 也顺带覆盖「过滤自己」「PR 不算新帖」「端到端两轮」三条（C4 / C6 / C3）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithub } from '../lib/github.js'
import { defaultState, planBaseline, planFresh } from '../lib/state.js'

const LOGIN = 'leno-whale'

const comment = (id, at, login = 'someone', issueNo = 88) => ({
  id,
  created_at: at,
  body: `回音 ${id}`,
  html_url: `https://github.com/o/r/issues/${issueNo}#issuecomment-${id}`,
  issue_url: `https://api.github.com/repos/o/r/issues/${issueNo}`,
  user: { login },
})

const issue = (id, number, at, login = 'someone') => ({
  id,
  number,
  created_at: at,
  title: `新帖 ${number}`,
  body: `正文 ${number}`,
  html_url: `https://github.com/o/r/issues/${number}`,
  user: { login },
})

test('空 state + 3 条历史评论 → pending 为空、seen 记 3 条、baselined=true', () => {
  const history = [
    comment(1, '2026-10-20T09:00:00Z'),
    comment(2, '2026-10-21T09:00:00Z'),
    comment(3, '2026-10-22T09:00:00Z'),
  ]
  const state = planBaseline(defaultState(), { comments: history, issues: [], newestAt: '2026-10-22T09:00:00Z' })

  assert.deepEqual(state.pending, [], '基线绝不能产生 pending')
  assert.equal(state.seen.length, 3)
  assert.equal(state.baselined, true)
  assert.equal(state.sinceComments, '2026-10-22T09:00:00Z', 'since 落在最新一条（服务器时间）')
})

test('基线把开帖的时间记进 sinceIssues（不然第一轮会把所有老帖当新帖）', () => {
  const state = planBaseline(defaultState(), {
    comments: [comment(1, '2026-10-20T09:00:00Z')],
    issues: [issue(900, 80, '2026-10-01T00:00:00Z'), issue(901, 81, '2026-10-02T00:00:00Z')],
    newestAt: '2026-10-20T09:00:00Z',
  })
  assert.equal(state.seen.length, 1, 'seen 只记评论；开帖用 sinceIssues 挡')
  assert.equal(state.sinceIssues, '2026-10-02T00:00:00Z', '开帖游标落在最新的开帖')
  assert.deepEqual(state.pending, [])

  // 基线后把这些老帖再喂一遍：一条都不该算新。
  const { fresh } = planFresh(state, { comments: [], issues: [issue(900, 80, '2026-10-01T00:00:00Z'), issue(901, 81, '2026-10-02T00:00:00Z')] })
  assert.deepEqual(fresh, [])
})

test('基线之后再来的评论才算新（过滤自己）', () => {
  const history = [comment(1, '2026-10-20T09:00:00Z'), comment(2, '2026-10-21T09:00:00Z', LOGIN)]
  const base = planBaseline(defaultState(), { comments: history, issues: [], newestAt: '2026-10-21T09:00:00Z' })

  // 我自己的新回音不该叫我
  const mineOnly = planFresh(base, { comments: [comment(3, '2026-10-23T09:00:00Z', LOGIN)], issues: [], login: LOGIN })
  assert.deepEqual(mineOnly.fresh, [], '自己说的话不算新件（C6）')
  assert.equal(mineOnly.state.pending.length, 0)
  // 别人在同一轮里的回音要留
  const mixed = planFresh(base, {
    comments: [comment(4, '2026-10-23T10:00:00Z', 'shiomi-lanxi'), comment(5, '2026-10-23T11:00:00Z', LOGIN)],
    issues: [],
    login: LOGIN,
  })
  assert.deepEqual(mixed.fresh.map((x) => x.who), ['shiomi-lanxi'])
})

test('PR 不算新帖（issue 接口里带 pull_request 的要丢掉）', () => {
  const base = {
    ...defaultState(),
    baselined: true,
    sinceComments: '2026-10-20T00:00:00Z',
    sinceIssues: '2026-10-25T09:00:00Z',
  }
  const { fresh } = planFresh(base, {
    comments: [],
    issues: [
      { ...issue(910, 90, '2026-10-25T10:00:00Z'), pull_request: { url: 'x' } },
      issue(911, 91, '2026-10-25T11:00:00Z'),
    ],
    login: LOGIN,
  })
  assert.deepEqual(fresh.map((x) => x.no), [91])
})

test('端到端：第一轮两页建基线不投，第二轮只投真正新的一条', async () => {
  const history = [
    comment(1, '2026-10-20T09:00:00Z'),
    comment(2, '2026-10-21T09:00:00Z'),
    comment(3, '2026-10-22T09:00:00Z'),
  ]
  const oldIssues = [issue(900, 80, '2026-10-01T00:00:00Z')]
  const calls = []

  const gh = createGithub({
    token: 'x',
    fetchImpl: async (url) => {
      calls.push(url)
      const link = (next) => ({ get: (n) => (String(n).toLowerCase() === 'link' ? next : null) })
      const ok = (body, next = '') => ({ ok: true, status: 200, statusText: 'OK', headers: link(next), json: async () => body })

      if (url.includes('/issues/comments')) {
        if (url.includes('since=')) return ok([comment(4, '2026-10-25T12:00:00Z', 'shiomi-lanxi')])
        // 基线：第一页给 2 条 + next，第二页给 1 条
        if (!url.includes('page=2')) {
          return ok(history.slice(0, 2), '<https://api.github.com/repos/o/r/issues/comments?page=2&per_page=100>; rel="next"')
        }
        return ok(history.slice(2))
      }
      return ok(oldIssues)
    },
  })

  // 第一轮：基线
  const first = await gh.listComments({ repo: 'o/r', maxPages: 10 })
  const firstIssues = await gh.listIssues({ repo: 'o/r', maxPages: 10 })
  assert.equal(first.pages, 2, '基线也要翻页')
  const st1 = planBaseline(defaultState(), {
    comments: first.items,
    issues: firstIssues.items,
    newestAt: first.items.at(-1).created_at,
  })
  assert.equal(st1.pending.length, 0)

  // 第二轮：只拉 since 之后
  const second = await gh.listComments({ repo: 'o/r', since: st1.sinceComments, maxPages: 10 })
  const secondIssues = await gh.listIssues({ repo: 'o/r', maxPages: 10 })
  const round2 = planFresh(st1, { comments: second.items, issues: secondIssues.items, login: LOGIN })

  assert.equal(round2.fresh.length, 1, '两轮里同一条历史不能让 pending 变多')
  assert.equal(round2.fresh[0].no, 88)
  assert.equal(round2.fresh[0].body, '回音 4')
  assert.equal(round2.state.pending.length, 1)
  assert.equal(round2.state.sinceComments, '2026-10-25T12:00:00Z')
})
