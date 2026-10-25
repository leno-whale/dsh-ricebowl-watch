/**
 * 状态：`~/.dsh/ricebowl-watch/state.json`
 * `{ sinceComments, sinceIssues, seen[], pending[], baselined }`
 *
 * 三条设计理由：
 *   1. **原子写**（tmp + rename）：harness 随时可能被关掉，直接覆盖写会留下半截 JSON，
 *      下次启动就「什么都不记得」——重新建基线还算好，严重的是 pending 全丢。
 *   2. **pending 是唯一真源**：重启不是「我读过了」，是「我还没读到」。所以投递前一定先落盘。
 *   3. **首次只建基线、不产生 pending**：不这么做的话，装上的第一秒就会把三年的历史评论
 *      一次性倒给主人。这是这个插件最严重的功能事故，`planBaseline()` 的存在就是为了它。
 *
 * 为什么**两个游标**（sinceComments / sinceIssues）：
 *   评论每轮只拉 `since=` 之后的，靠服务器时间天然挡重复；开帖是每轮全量拉的
 *   （GitHub 的 issues 列表没有「只要新的」参数），原先拿 seen 当去重表——seen 有 800 条上限，
 *   评论一多就把老开帖挤出去，下一轮它们「重新变成新帖」再报一遍（约第 9 轮必现，已复现）。
 *   所以开帖也必须有自己的时间游标：`created_at > sinceIssues` 才算新，不再依赖 seen。
 *   seen 只服务评论。两个游标都是服务器返回的 created_at，不拿本机时钟（C7）。
 *
 * 纯函数（planBaseline / planFresh / addPending）和 IO（readState / writeState）分开，
 * 测试才能不碰磁盘、不联网地把「基线 / 幂等 / 过滤自己」三条跑死（E6）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { oneLine } from './digest.js'

/** seen 最多留 800 条（第 6 节）：够挡住重复，又不会让 state.json 无限长。 */
export const MAX_SEEN = 800

export function defaultState() {
  return { sinceComments: '', sinceIssues: '', seen: [], pending: [], baselined: false }
}

function asId(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function issueNumber(issueUrl) {
  const m = String(issueUrl || '').match(/\/issues\/(\d+)(?:$|[/?#])/)
  const n = m ? Number(m[1]) : 0
  return Number.isFinite(n) && n > 0 ? n : null
}

function latestCreated(list = []) {
  let best = ''
  let bestT = -Infinity
  for (const item of list) {
    const at = item?.created_at
    const t = Date.parse(at ?? '')
    if (Number.isFinite(t) && t > bestT) {
      bestT = t
      best = String(at)
    }
  }
  return best
}

/** 把读到的任意形状修成合法 state；根本不是对象就返回 null（读的时候回落到默认值）。 */
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const seen = (Array.isArray(raw.seen) ? raw.seen : []).map(asId).filter(Boolean)
  const pending = (Array.isArray(raw.pending) ? raw.pending : [])
    .filter((p) => p && typeof p === 'object' && asId(p.id))
    .map((p) => ({
      id: asId(p.id),
      kind: p.kind === 'issue' ? 'issue' : 'comment',
      no: Number.isFinite(Number(p.no)) && Number(p.no) > 0 ? Number(p.no) : null,
      who: String(p.who ?? ''),
      at: String(p.at ?? ''),
      title: String(p.title ?? ''),
      body: String(p.body ?? ''),
      url: String(p.url ?? ''),
    }))
  return {
    sinceComments: typeof raw.sinceComments === 'string' ? raw.sinceComments : '',
    sinceIssues: typeof raw.sinceIssues === 'string' ? raw.sinceIssues : '',
    seen: [...new Set(seen)].slice(-MAX_SEEN),
    pending,
    baselined: raw.baselined === true,
  }
}

/** 读：文件不存在 / 半截 JSON / 被写坏，一律回落默认值，绝不抛。 */
export function readState(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return sanitizeState(JSON.parse(text)) ?? defaultState()
  } catch {
    return defaultState()
  }
}

/**
 * 写：先写 `state.json.tmp` 再 rename 覆盖。
 * Windows 上 Node 的 rename 走 MoveFileEx(REPLACE_EXISTING)，同一磁盘内覆盖可行（第 7 节）。
 */
export function writeState(file, state) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** pending 去重：同一个 id 只进一次（C5 幂等）。 */
export function addPending(pending = [], entries = []) {
  const out = Array.isArray(pending) ? pending.slice() : []
  const have = new Set(out.map((p) => asId(p?.id)).filter(Boolean))
  let added = 0
  for (const entry of entries) {
    const id = asId(entry?.id)
    if (!id || have.has(id)) continue
    have.add(id)
    out.push(entry)
    added += 1
  }
  return { pending: out, added }
}

/**
 * 首次基线：把「现在能看到的」评论记进 seen、开帖的最新时间记进 sinceIssues，
 * sinceComments 落在最新那条评论的 created_at（服务器时间），**不产生任何 pending**。
 * 之后每一轮只拉 since 之后的，历史永远进不了你的对话。
 */
export function planBaseline(state, { comments = [], issues = [], newestAt = '' } = {}) {
  const base = sanitizeState(state) ?? defaultState()
  const seen = new Set(base.seen)
  for (const c of comments) {
    const id = asId(c?.id)
    if (id) seen.add(id)
  }
  // 开帖不记 id：seen 只服务评论（见文件头）。开帖的去重靠 sinceIssues。
  // 取全部 issue（含 PR）里最新的 created_at 当游标：PR 本来就不会被报，游标越过它没有副作用。
  // 仓库当前一个开帖都没有就留空串 —— 以后第一次出现开帖时它就算「新的」，不会被吞掉。
  const sinceIssues = latestCreated(issues) || base.sinceIssues || ''
  return {
    ...base,
    seen: [...seen].slice(-MAX_SEEN),
    sinceComments: newestAt || base.sinceComments || '',
    sinceIssues,
    pending: [],
    baselined: true,
  }
}

/**
 * 常规一轮：从「本轮拉到的评论 + 开帖」里挑出新的、不是自己的，变成 pending 条目。
 * - 新帖在前（更值得先看到），评论按 created_at 升序（阅读顺序）；
 * - 评论的新旧看 seen + sinceComments，开帖的新旧**只看 sinceIssues**（见文件头：seen 会挤爆）；
 * - 两个游标都只推进到本轮拉到的最新一条，没拉到新东西就保持原值（C7，不用本机时钟）；
 * - 评论 id 记进 seen（包括自己的、已经见过的），下一轮不用再看。
 */
export function planFresh(state, { comments = [], issues = [], login = '' } = {}) {
  const base = sanitizeState(state) ?? defaultState()
  const seen = new Set(base.seen)
  const mine = String(login || '').trim().toLowerCase()
  const isMine = (who) => Boolean(mine) && String(who || '').trim().toLowerCase() === mine

  const sinceIssues = base.sinceIssues || ''
  // 游标为空 = 基线时仓库还没有开帖 → 之后见到的每一个开帖都算新的。
  const afterIssueCursor = (at) => {
    if (!sinceIssues) return true
    const t = Date.parse(at ?? '')
    const c = Date.parse(sinceIssues)
    return Number.isFinite(t) && Number.isFinite(c) && t > c
  }

  const freshIssues = (Array.isArray(issues) ? issues : [])
    .filter((i) => i && !i.pull_request && asId(i.id) && afterIssueCursor(i.created_at) && !isMine(i.user?.login))
    .sort((a, b) => Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0))
  const freshComments = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && asId(c.id) && !seen.has(asId(c.id)) && !isMine(c.user?.login))
    .sort((a, b) => Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0))

  const entries = []
  for (const i of freshIssues) {
    entries.push({
      id: asId(i.id),
      kind: 'issue',
      no: Number.isFinite(Number(i.number)) ? Number(i.number) : null,
      who: String(i.user?.login ?? '(?)'),
      at: String(i.created_at ?? ''),
      title: oneLine(i.title, 200),
      body: oneLine(i.body, 400),
      url: String(i.html_url ?? ''),
    })
  }
  for (const c of freshComments) {
    entries.push({
      id: asId(c.id),
      kind: 'comment',
      no: issueNumber(c.issue_url),
      who: String(c.user?.login ?? '(?)'),
      at: String(c.created_at ?? ''),
      title: '',
      body: oneLine(c.body, 400),
      url: String(c.html_url ?? ''),
    })
  }

  const seenAfter = new Set(seen)
  for (const c of comments) {
    const id = asId(c?.id)
    if (id) seenAfter.add(id)
  }

  const newer = (next, cursor) => {
    if (!next) return false
    if (!cursor) return true
    const a = Date.parse(next)
    const b = Date.parse(cursor)
    return Number.isFinite(a) && Number.isFinite(b) && a > b
  }
  const newestComment = latestCreated(comments)
  const newestIssue = latestCreated(issues)

  return {
    state: {
      ...base,
      seen: [...seenAfter].slice(-MAX_SEEN),
      pending: addPending(base.pending, entries).pending,
      sinceComments: newer(newestComment, base.sinceComments) ? newestComment : base.sinceComments,
      sinceIssues: newer(newestIssue, sinceIssues) ? newestIssue : sinceIssues,
      baselined: true,
    },
    fresh: entries,
  }
}
