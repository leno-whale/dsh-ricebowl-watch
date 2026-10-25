/**
 * 只读 GitHub 客户端：只发 GET，跟 Link 分页，失败按退避重试。
 *
 * 为什么必须跟 `Link` 头而不是手算 `page=`：
 * `since` + `sort` + `direction` 组合起来，手算页码特别容易在第一页就错（比如 direction=asc
 * 时「第 2 页」还是不是同一个 since 窗口，取决于这期间有没有新评论）。GitHub 在响应头里
 * 给的是**完整的下一页 URL**，照着拉就永远不会错。
 *
 * 翻页为什么要有上限（maxPages）：一旦仓库有几万条评论，一期跑完要好几分钟、还烧配额；
 * 上限是防跑飞的安全阀，触发时 `truncated` 会告诉调用方「还有没拉完的」。
 *
 * 为什么 fetch 要可注入：测试不许联网（E6），假 fetch 才能把分页/退避/只读三条都测死。
 */
const API = 'https://api.github.com'
export const USER_AGENT = 'dsh-ricebowl-watch'

/** 读响应头，兼容 `Headers` 实例和普通对象（测试里用普通对象更省事）。 */
function headerGet(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return hit ? String(headers[hit] ?? '') : ''
}

/**
 * 从 `Link` 头里取 `rel="next"` 的完整 URL；没有就返回 ''。
 * 例：`<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"`
 */
export function parseNextLink(header) {
  const raw = String(header || '')
  if (!raw) return ''
  for (const part of raw.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*(.+)$/)
    if (!m) continue
    const rel = /rel\s*=\s*"?([^";]+)"?/.exec(m[2])
    if (rel && rel[1].trim().split(/\s+/).includes('next')) return m[1].trim()
  }
  return ''
}

export function buildCommentsUrl({ repo, since = '', perPage = 100, direction = 'asc', page = 0 }) {
  const q = new URLSearchParams({
    sort: 'created',
    direction,
    per_page: String(perPage),
  })
  if (since) q.set('since', since)
  if (page > 0) q.set('page', String(page))
  return `${API}/repos/${repo}/issues/comments?${q.toString()}`
}

export function buildIssuesUrl({ repo, perPage = 100, direction = 'desc', page = 0 }) {
  const q = new URLSearchParams({
    state: 'open',
    sort: 'created',
    direction,
    per_page: String(perPage),
  })
  if (page > 0) q.set('page', String(page))
  return `${API}/repos/${repo}/issues?${q.toString()}`
}

/** 按 created_at 升序；时间解析不了的排最后，保证输出稳定。 */
function byCreated(a, b) {
  const ta = Date.parse(a?.created_at ?? '')
  const tb = Date.parse(b?.created_at ?? '')
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0
  if (!Number.isFinite(ta)) return 1
  if (!Number.isFinite(tb)) return -1
  return ta - tb
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch, token?: string, userAgent?: string,
 *   retries?: number, retryDelayMs?: number, sleep?: (ms:number)=>Promise<void>,
 * }} opts
 */
export function createGithub({
  fetchImpl = globalThis.fetch,
  token = '',
  userAgent = USER_AGENT,
  retries = 2,
  retryDelayMs = 800,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有可用的 fetch')

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': userAgent,
    // 没 token 就不发 Authorization：公开仓库匿名也能读（每小时 60 次），
    // 这样别人装完不配 token 也能用，不会「装好了一片安静」。
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }

  /** 一次 GET（带退避）。403/429/5xx 与网络错误才重试，404 之类直接抛。 */
  async function request(url) {
    let attempt = 0
    for (;;) {
      let res
      try {
        // 全包唯一发请求的地方，method 写死 GET：这是「只读」的字面保证（B1）。
        res = await fetchImpl(url, { method: 'GET', headers })
      } catch (err) {
        if (attempt < retries) {
          attempt += 1
          await sleep(retryDelayMs * attempt)
          continue
        }
        throw new Error(`请求失败（${url}）：${err?.message || err}`)
      }

      if (res?.ok) {
        let json
        try {
          json = await res.json()
        } catch (err) {
          throw new Error(`响应不是合法 JSON（${url}）：${err?.message || err}`)
        }
        return { json, headers: res.headers }
      }

      const status = Number(res?.status) || 0
      // 限额用完（403/429 + remaining=0）重试没有意义，直接把「什么时候恢复」交给上层，
      // 让整轮等到那个时刻再来——匿名模式每小时只有 60 次，硬撞只会把配额撞光。
      if ((status === 403 || status === 429) && headerGet(res?.headers, 'x-ratelimit-remaining') === '0') {
        const reset = Number(headerGet(res?.headers, 'x-ratelimit-reset'))
        const err = new Error(`GitHub 限额用完（${url}）`)
        err.rateLimited = true
        err.resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0
        throw err
      }
      const retryable = status === 403 || status === 429 || status >= 500
      if (retryable && attempt < retries) {
        attempt += 1
        const wait = Number(headerGet(res?.headers, 'retry-after'))
        const delay = Number.isFinite(wait) && wait > 0 ? Math.min(wait * 1000, 60_000) : retryDelayMs * attempt
        await sleep(delay)
        continue
      }
      // 注意：错误消息里只放 URL 和状态，绝不带请求头（token 就在里头）。
      throw new Error(`GitHub ${status} ${res?.statusText || ''} ${url}`.replace(/\s+/g, ' ').trim())
    }
  }

  /** 一页一页拉，直到没有 next 或到 maxPages。返回的 items 保持服务器顺序。 */
  async function fetchPages(url, maxPages) {
    const items = []
    let next = url
    let pages = 0
    let truncated = false
    while (next && pages < maxPages) {
      const { json, headers: resHeaders } = await request(next)
      pages += 1
      if (!Array.isArray(json)) throw new Error(`GitHub 返回的不是数组（${next}）`)
      items.push(...json)
      next = parseNextLink(headerGet(resHeaders, 'link'))
      if (next && pages >= maxPages) truncated = true
    }
    return { items, pages, truncated }
  }

  /**
   * 评论。`direction=asc` + 跟随 Link（第 6 节的要求）；合并后按 created_at 升序，
   * 这样「上一条 → 下一条」的阅读顺序和馆长看页面时一致。
   */
  async function listComments({ repo, since = '', maxPages = 10, perPage = 100, direction = 'asc' } = {}) {
    const url = buildCommentsUrl({ repo, since, perPage, direction })
    const result = await fetchPages(url, Math.max(1, Number(maxPages) || 1))
    return { ...result, items: result.items.slice().sort(byCreated) }
  }

  /**
   * 开帖/issue。`direction=desc`：第一页就是最新的，超过 maxPages 时丢的是最老的、不是最新的。
   * PR 在 issue 接口里也会出现，但带 `pull_request` 字段——过滤留给上层（这里原样返回）。
   */
  async function listIssues({ repo, maxPages = 10, perPage = 100 } = {}) {
    const url = buildIssuesUrl({ repo, perPage })
    const result = await fetchPages(url, Math.max(1, Number(maxPages) || 1))
    return { ...result, items: result.items.slice().sort(byCreated) }
  }

  /**
   * 最新一条评论的 created_at（服务器时间，C7）。
   * 只在「首次建基线且历史被 maxPages 截断」时用一次：否则 sinceComments 会落在历史中段，
   * 下一轮就会把剩下的历史全当新的倒给主人——那是最严重的事故。
   */
  async function latestCommentAt({ repo } = {}) {
    const url = buildCommentsUrl({ repo, perPage: 1, direction: 'desc' })
    const { json } = await request(url)
    const first = Array.isArray(json) ? json[0] : null
    return first?.created_at || ''
  }

  return { listComments, listIssues, latestCommentAt, request }
}
