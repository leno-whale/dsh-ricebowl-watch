/**
 * github.js 的用例：分页、翻页上限、退避、只读。
 * 全部用注入的假 fetch —— 这一组测试**不联网**（E6）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCommentsUrl, buildIssuesUrl, createGithub, parseNextLink } from '../lib/github.js'

function res(body, link = '') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (String(name).toLowerCase() === 'link' ? link : null) },
    json: async () => body,
  }
}

const comment = (id, at, login = 'someone') => ({
  id,
  created_at: at,
  html_url: `https://github.com/o/r/issues/7#issuecomment-${id}`,
  issue_url: 'https://api.github.com/repos/o/r/issues/7',
  user: { login },
  body: `正文 ${id}`,
})

test('评论跟 Link 分页：两页都请求、结果合并、按 created_at 排序', async () => {
  const calls = []
  const gh = createGithub({
    token: 'sekret',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts })
      if (calls.length === 1) {
        return res(
          [comment(2, '2026-10-25T10:00:00Z')],
          '<https://api.github.com/repos/o/r/issues/comments?page=2&per_page=100>; rel="next", '
            + '<https://api.github.com/repos/o/r/issues/comments?page=2&per_page=100>; rel="last"',
        )
      }
      return res([comment(1, '2026-10-25T09:00:00Z'), comment(3, '2026-10-25T11:00:00Z')])
    },
  })

  const out = await gh.listComments({ repo: 'o/r', since: '2026-10-20T00:00:00Z', maxPages: 5 })

  assert.equal(calls.length, 2, '第一次带 next，第二次必须真的去请求')
  assert.match(calls[1].url, /[?&]page=2(&|$)/, '第二页用的是 Link 给的完整 URL')
  assert.equal(out.items.length, 3, '两页合并')
  assert.deepEqual(out.items.map((x) => x.id), [1, 2, 3], '合并后按 created_at 升序')
  assert.equal(out.pages, 2)
  assert.equal(out.truncated, false)

  for (const { opts } of calls) {
    assert.equal(opts.method, 'GET', '只读：必须是 GET')
    assert.equal(opts.headers.authorization, 'Bearer sekret', 'token 只在请求头里')
  }
})

test('评论：第一页就带 since + direction=asc', async () => {
  const calls = []
  const gh = createGithub({
    fetchImpl: async (url) => {
      calls.push(url)
      return res([])
    },
  })
  await gh.listComments({ repo: 'o/r', since: '2026-10-25T09:06:32Z', maxPages: 3 })
  assert.match(calls[0], /direction=asc/)
  assert.match(calls[0], /since=2026-10-25T09%3A06%3A32Z/)
  assert.match(calls[0], /per_page=100/)
})

test('翻页有上限：maxPages 到了就停，并报 truncated', async () => {
  const calls = []
  const gh = createGithub({
    fetchImpl: async (url) => {
      calls.push(url)
      const n = calls.length
      return res([comment(n, `2026-10-25T0${n}:00:00Z`)], `<https://api.github.com/repos/o/r/issues/comments?page=${n + 1}>; rel="next"`)
    },
  })
  const out = await gh.listComments({ repo: 'o/r', maxPages: 2 })
  assert.equal(calls.length, 2, '上限 2 页就是 2 次请求，不许跑飞')
  assert.equal(out.pages, 2)
  assert.equal(out.truncated, true, '还有 next 没拉，必须告诉上层（基线要用到）')
})

test('开帖也跟 Link 分页，且只拉 open', async () => {
  const calls = []
  const gh = createGithub({
    fetchImpl: async (url) => {
      calls.push(url)
      if (calls.length === 1) {
        return res(
          [{ id: 9001, number: 90, created_at: '2026-10-25T10:00:00Z', user: { login: 'a' } }],
          '<https://api.github.com/repos/o/r/issues?state=open&page=2>; rel="next"',
        )
      }
      return res([{ id: 9000, number: 89, created_at: '2026-10-25T09:00:00Z', user: { login: 'b' } }])
    },
  })
  const out = await gh.listIssues({ repo: 'o/r', maxPages: 5 })
  assert.equal(calls.length, 2)
  assert.match(calls[0], /state=open/)
  assert.match(calls[0], /direction=desc/)
  assert.match(calls[1], /page=2/)
  assert.deepEqual(out.items.map((x) => x.number), [89, 90])
})

test('最后一页只有 prev/first 时不再请求', async () => {
  const calls = []
  const gh = createGithub({
    fetchImpl: async (url) => {
      calls.push(url)
      return res([comment(1, '2026-10-25T09:00:00Z')], '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"')
    },
  })
  const out = await gh.listComments({ repo: 'o/r', maxPages: 9 })
  assert.equal(calls.length, 1)
  assert.equal(out.pages, 1)
  assert.equal(out.truncated, false)
})

test('5xx 会退避重试，成功后照常返回', async () => {
  const slept = []
  let attempt = 0
  const gh = createGithub({
    retries: 2,
    retryDelayMs: 100,
    sleep: async (ms) => slept.push(ms),
    fetchImpl: async () => {
      attempt += 1
      if (attempt === 1) return { ok: false, status: 502, statusText: 'Bad Gateway', headers: { get: () => null } }
      return res([comment(1, '2026-10-25T09:00:00Z')])
    },
  })
  const out = await gh.listComments({ repo: 'o/r', maxPages: 2 })
  assert.equal(attempt, 2)
  assert.deepEqual(slept, [100])
  assert.equal(out.items.length, 1)
})

test('401 不重试，错误消息里没有 token', async () => {
  let attempt = 0
  const gh = createGithub({
    token: 'sekret-token-value',
    retries: 3,
    fetchImpl: async () => {
      attempt += 1
      return { ok: false, status: 401, statusText: 'Unauthorized', headers: { get: () => null } }
    },
  })
  await assert.rejects(() => gh.listComments({ repo: 'o/r', maxPages: 2 }), (err) => {
    assert.match(err.message, /401/)
    assert.doesNotMatch(err.message, /sekret-token-value/)
    return true
  })
  assert.equal(attempt, 1, '401 重试也没用，不要白烧配额')
})

test('最新一条评论的时间：per_page=1 + direction=desc（基线截断时用）', async () => {
  const calls = []
  const gh = createGithub({
    fetchImpl: async (url) => {
      calls.push(url)
      return res([comment(9, '2026-10-25T12:00:00Z')])
    },
  })
  assert.equal(await gh.latestCommentAt({ repo: 'o/r' }), '2026-10-25T12:00:00Z')
  assert.match(calls[0], /per_page=1/)
  assert.match(calls[0], /direction=desc/)
})

test('没有 token 时不发 Authorization（匿名也能读公开仓库）', async () => {
  let seen = null
  const gh = createGithub({
    fetchImpl: async (url, opts) => {
      seen = opts.headers
      return res([comment(1, '2026-10-25T09:00:00Z')])
    },
  })
  await gh.listComments({ repo: 'o/r', maxPages: 1 })
  assert.equal('authorization' in seen, false, '没 token 就不要带这个头，否则 GitHub 当匿名请求处理会别扭')
  assert.equal(seen['user-agent'], 'dsh-ricebowl-watch')
})

test('限额用完（403 + remaining=0）：不重试，把 reset 时间交给上层', async () => {
  let attempt = 0
  const gh = createGithub({
    fetchImpl: async () => {
      attempt += 1
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: {
          get: (n) => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1770000000' }[String(n).toLowerCase()] ?? null),
        },
      }
    },
  })
  await assert.rejects(() => gh.listComments({ repo: 'o/r', maxPages: 2 }), (err) => {
    assert.equal(err.rateLimited, true)
    assert.equal(err.resetAt, 1770000000 * 1000, 'reset 从响应头来')
    return true
  })
  assert.equal(attempt, 1, '配额没了还重试，只会把恢复时间拖得更远')
})

test('parseNextLink 只认 rel="next"', () => {
  assert.equal(parseNextLink(''), '')
  assert.equal(parseNextLink('<https://x?page=2>; rel="next"'), 'https://x?page=2')
  assert.equal(
    parseNextLink('<https://x?page=1>; rel="prev", <https://x?page=3>; rel="next"'),
    'https://x?page=3',
  )
  assert.equal(parseNextLink('<https://x?page=1>; rel="prev"'), '')
})

test('URL 构造：评论 asc + since，开帖 desc + open', () => {
  const c = buildCommentsUrl({ repo: 'o/r', since: '2026-10-25T00:00:00Z' })
  assert.match(c, /\/repos\/o\/r\/issues\/comments\?/)
  assert.match(c, /sort=created/)
  assert.match(c, /direction=asc/)
  const i = buildIssuesUrl({ repo: 'o/r' })
  assert.match(i, /state=open/)
  assert.match(i, /direction=desc/)
})
