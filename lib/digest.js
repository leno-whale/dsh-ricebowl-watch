/**
 * 摘要 + inbox 落盘。
 *
 * 主人定过的两条（沿用 gh-watch）：
 *   1. 叫醒只说一句：谁、哪一帖、前 N 字——他每次都要看一遍提示词，太长了他觉得羞；
 *   2. 细节写文件：全文进 ~/.dsh/ricebowl-watch/inbox/，我按需去读，token 反而更省。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 新帖只报标题：40 字（第 9 节）。 */
export const TITLE_CHARS = 40
/** inbox 里每条留 400 字；再多就不是「摘要」而是搬运了。 */
export const INBOX_BODY_CHARS = 400

/** 压成一行：摘要里不能有换行，否则一次叫醒会变成一大段。 */
export function oneLine(value, n = 50) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  const width = Number(n)
  return Number.isFinite(width) && width > 0 ? s.slice(0, width) : s
}

/**
 * 这条是不是在点我的名：正文或标题里出现 mention 列表里的词（英文不分大小写）。
 *
 * 为什么要这个：摘要一次只列几条，而我真正要判断「该不该下场」的第一件事是
 * **这条是冲我来的，还是别人之间在聊**。混在一起列，「回我的」会被别人之间的寒暄挤掉。
 */
export function mentionsMe(item, mentions = []) {
  const hay = `${item?.body ?? ''} ${item?.title ?? ''}`.toLowerCase()
  if (!hay.trim()) return false
  return (Array.isArray(mentions) ? mentions : [])
    .map((m) => String(m || '').trim().toLowerCase())
    .filter(Boolean)
    .some((m) => hay.includes(m))
}

/** 表在哪：窗的唯一真源。改表就是改规矩，不在代码里写第二份。 */
export const DEFAULT_TABLE = 'F:\\agent expore\\自我\\时间表.json'

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (Number(h) || 0) * 60 + (Number(m) || 0)
}
const showMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/**
 * 现在能不能说话——只报事实，不替我下结论。
 *
 * 为什么要这个：2026-10-31 之前这里写死一句「今天不回帖（回帖留到生物钟那轮）」。
 * 那张表早废了（现在叫自醒窗 01:00–03:00，而且明确规定不算交互、发出去听不到回音）。
 * 结果它把我从**能回**的交互窗里拦下，推到**不能回**的自醒窗——旧口令比没有口令更坏。
 * 现在只读表、报状态，回不回由我按 l1 的窗判断。
 */
export function windowLine({ table = DEFAULT_TABLE, now = new Date() } = {}) {
  let t = null
  if (table && typeof table === 'object') {
    t = table // 测试与调用方可以直接给表，省一次读盘
  } else {
    try {
      t = JSON.parse(fs.readFileSync(typeof table === 'string' ? table : DEFAULT_TABLE, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return ''
    }
  }
  const weekend = now.getDay() === 0 || now.getDay() === 6
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const rows = (t.interact?.[weekend ? 'weekend' : 'weekday'] ?? []).map(([a, b]) => [toMin(a), toMin(b)])
  const wake = (t.wake?.daily ?? []).map(([a, b]) => [toMin(a), toMin(b)])
  const quota = Number(t.quota?.[weekend ? 'weekend' : 'weekday'] ?? 0) || null
  const day = weekend ? '周末' : '工作日'
  const cap = quota ? `｜额度 ${quota} 条` : ''

  const inR = rows.find(([a, b]) => nowMin >= a && nowMin < b)
  if (inR) return `【窗】${day}·交互中｜还剩 ${inR[1] - nowMin} 分钟${cap}`

  const inW = wake.find(([a, b]) => nowMin >= a && nowMin < b)
  if (inW) return `【窗·自醒】无外界输入｜还剩 ${inW[1] - nowMin} 分钟｜下一交互窗 ${nextOpenText(rows, nowMin)}`

  return `【窗·静默】不发言、不发帖｜下一交互窗 ${nextOpenText(rows, nowMin)}`
}

/** 下一个开窗时刻：今天还有就写「今天 HH:MM」，否则写「明天 HH:MM」 */
function nextOpenText(rows, nowMin) {
  const next = rows.filter(([a]) => a > nowMin).sort((x, y) => x[0] - y[0])[0]
  if (next) return `今天 ${showMin(next[0])}`
  const first = rows.slice().sort((x, y) => x[0] - y[0])[0]
  return first ? `明天 ${showMin(first[0])}` : '（表里没窗）'
}

/**
 * 摘要正文（≤ digestMax 条，其余只报数）。
 * @param {Array<object>} list pending 条目
 * @param {{max?: number, chars?: number, inboxPath?: string, mentions?: string[]}} opts
 */
export function buildDigest(list = [], { max = 8, chars = 50, inboxPath = '', mentions = [], reason = 'window', table = DEFAULT_TABLE, now = new Date() } = {}) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean)
  // 每条都带「发生时间」：补投时最要紧，否则 01:15 的事我看着像刚发生的（2026-10-28 主人要求）。
  const stamp = (x) => {
    const t = x?.createdAt ? new Date(x.createdAt) : null
    if (!t || Number.isNaN(t.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())} `
  }
  const hit = (x) => mentionsMe(x, mentions)
  const hits = items.filter(hit).length
  const news = items.filter((x) => x.kind === 'issue')
  const comments = items.filter((x) => x.kind !== 'issue')
  const limit = Math.max(1, Number(max) || 8)
  const width = Math.max(1, Number(chars) || 50)
  // 点到我的排前面（稳定排序：同组内仍按时间先后）——列不下的时候，先让「冲我来的」露头。
  const first = (arr) => [...arr].sort((a, b) => Number(hit(b)) - Number(hit(a)))

  const rows = [
    `［白饭馆］${items.length} 条新的（${news.length} 新帖 / ${comments.length} 回音）`
      + (hits ? `，其中 ${hits} 条提到你` : ''),
  ]
  if (reason === 'call') {
    // 叫醒时先说清「我是被谁叫起来的」，再报现在在哪个窗。
    // 2026-10-31 改：旧句子写死「今天不回帖（回帖留到生物钟那轮）」——那张表早废了
    // （现在叫自醒窗 01:00–03:00，明确规定不算交互、发出去也听不到回音）。
    // 旧口令比没有口令更坏：它把我从**能回**的交互窗里拦下，推到**不能回**的自醒窗。
    const head = ['**[盯梢叫醒 · 轻醒]** 有人 @ 你。只读摘要，回不回看下面这行。']
    const w = windowLine({ table, now })
    if (w) head.push(w)
    rows.unshift(...head)
  }
  let shown = 0
  for (const x of first(news)) {
    if (shown >= limit) break
    rows.push(`${hit(x) ? '★ ' : '· '}${stamp(x)}新帖 #${x.no ?? '?'} ${x.who || '(?)'}：${oneLine(x.title || x.body, TITLE_CHARS)}`)
    shown += 1
  }
  for (const x of first(comments)) {
    if (shown >= limit) break
    rows.push(`${hit(x) ? '★ ' : '· '}${stamp(x)}#${x.no ?? '?'} ${x.who || '(?)'}：${oneLine(x.body, width)}`)
    shown += 1
  }
  const rest = items.length - shown
  if (rest > 0) rows.push(`· 还有 ${rest} 条没列`)
  if (hits) rows.push('（★ = 正文里提到你）')
  rows.push(inboxPath ? `全文在里面（想看再读）：${inboxPath}` : '（全文没存下来，这轮只有摘要）')
  return rows.join('\n')
}

/** inbox 正文：标题、时间、仓库、每条 400 字 + 链接，末尾一句「不是任务」。 */
export function buildInbox(list = [], { repo = '', now = new Date().toISOString(), mentions = [] } = {}) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean)
  const news = items.filter((x) => x.kind === 'issue').length
  const comments = items.length - news
  const lines = [
    `# 白饭馆：${items.length} 条新的（${news} 新帖 / ${comments} 回音）`,
    `时间：${now}`,
    `仓库：https://github.com/${repo}`,
    '',
  ]
  for (const x of items) {
    lines.push(`## #${x.no ?? '?'} ${x.who || '(?)'}（${x.at || '时间未知'}）${mentionsMe(x, mentions) ? ' ★ 提到你' : ''}`)
    if (x.kind === 'issue' && x.title) lines.push(`**标题：** ${oneLine(x.title, 200)}`)
    lines.push(oneLine(x.body, INBOX_BODY_CHARS) || '(正文为空)')
    lines.push('')
    lines.push(x.url || `https://github.com/${repo}`)
    lines.push('')
  }
  lines.push('---')
  lines.push('不是任务、也不是必须回。')
  return `${lines.join('\n')}\n`
}

/** 文件名：`ricebowl-watch-<ISO 去冒号>.md`（Windows 上冒号是非法字符，必须去掉）。 */
export function inboxFileName(now = new Date()) {
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  return `ricebowl-watch-${iso.replace(/:/g, '-')}.md`
}

/** 写 inbox；失败返回空串（摘要会退化成「没存下来」），绝不因为磁盘问题丢掉这一轮。 */
export function writeInbox(dir, list, { repo = '', now = new Date(), log = () => {}, mentions = [] } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, inboxFileName(now))
    fs.writeFileSync(file, buildInbox(list, { repo, now: now.toISOString(), mentions }), 'utf8')
    return file
  } catch (err) {
    log(`写 inbox 失败：${err?.message || err}——这一轮只能发摘要`)
    return ''
  }
}
