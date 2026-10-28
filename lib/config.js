/**
 * 配置：cordis `config` 对象 > 同名环境变量 > 默认值。
 *
 * 为什么要三源合并：桌面端是把配置写进 profile 的 patch（走 `config:`），命令行/脚本的人
 * 习惯用环境变量，两条路都得能跑。优先级取「谁写得更具体谁赢」：插件配置 > 环境变量 > 默认。
 *
 * 为什么非法值一律回落到默认/上下限而不是报错：配置写错是常事，一写错就整个插件起不来，
 * 表现是「消息永远不来」，比「按默认值跑」糟得多。宁可降级跑，也不要因为一个数字不启动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 第 5 节的配置表；`ENV_KEYS` 是每个 key 的同名环境变量。 */
export const DEFAULTS = {
  repo: 'pianVei/rice-bowl',
  tokenFile: '~/.dsh/github-token.json',
  login: '',
  // 投递目标与会话空闲闸是两件事：消息落到哪个会话，和「哪个会话安静了才算我们不说话」。
  // 默认都跟着 sessionId 走；`sessionId` 留着是为了兼容旧配置与 `RICE_WATCH_SESSION`。
  sessionId: 'ricebowl-watch',
  deliverTo: '',
  idleSession: '',
  // 摘要里会把提到这些名字的那条**单独标出来**（逗号分隔；默认是我自己的账号）。
  mentionNames: 'leno-whale',
  cwd: '~/.dsh',
  pollMs: 60_000,
  bootMs: 30_000,
  idleMs: 120_000,
  digestChars: 50,
  digestMax: 8,
  maxPages: 10,
  logMaxBytes: 1_048_576,
  // 活跃时段（本地时间，HH:MM-HH:MM，逗号分隔，不跨零点）：只在这几段里拉取＋投递。
  // 2026-10-28 主人定：工作日 12:00–14:00、18:00–24:00；周末全天。
  // 其余时间沉睡：**不拉取**（少打接口，也省得夜里被叫起来）。
  activeWindows: '12:00-14:00,18:00-24:00',
  weekendAllDay: true,
  // 沉睡期唯一的口子：低频只查「@ 我的」。0 = 沉睡期完全不拉。
  // 为什么留这个口子：「沉睡不拉」和「@ 我随时答」不可能同时成立——不拉就无从知道有没有人点名。
  sleepPollMs: 900_000,
  // 「@ 我」触发叫醒，一天最多这么多次；超了就攒到下一个活跃窗。
  callWakeMaxPerDay: 3,
  // 攒够几条或攒多久才投（活跃窗内）。
  burstMax: 5,
  burstMs: 600_000,
  // 不打断对话：主人最后一条消息之后要静这么久才投（另有「上一条必须是我发的」判断）。
  afterUserMs: 600_000,
}

export const ENV_KEYS = {
  repo: 'RICE_WATCH_REPO',
  tokenFile: 'RICE_WATCH_TOKEN_FILE',
  login: 'RICE_WATCH_LOGIN',
  sessionId: 'RICE_WATCH_SESSION',
  deliverTo: 'RICE_WATCH_DELIVER_TO',
  idleSession: 'RICE_WATCH_IDLE_SESSION',
  mentionNames: 'RICE_WATCH_MENTIONS',
  pollMs: 'RICE_WATCH_POLL_MS',
  bootMs: 'RICE_WATCH_BOOT_MS',
  idleMs: 'RICE_WATCH_IDLE_MS',
  digestChars: 'RICE_WATCH_DIGEST_CHARS',
  digestMax: 'RICE_WATCH_DIGEST_MAX',
  maxPages: 'RICE_WATCH_MAX_PAGES',
  quietStart: 'RICE_WATCH_QUIET_START',
  quietEnd: 'RICE_WATCH_QUIET_END',
  activeWindows: 'RICE_WATCH_ACTIVE_WINDOWS',
  weekendAllDay: 'RICE_WATCH_WEEKEND_ALL_DAY',
  sleepPollMs: 'RICE_WATCH_SLEEP_POLL_MS',
  callWakeMaxPerDay: 'RICE_WATCH_CALL_WAKE_MAX',
  burstMax: 'RICE_WATCH_BURST_MAX',
  burstMs: 'RICE_WATCH_BURST_MS',
  afterUserMs: 'RICE_WATCH_AFTER_USER_MS',
}

/**
 * 找 token 时按顺序试的文件。
 *
 * 只认 `~/.dsh/github-token.json`：这是插件的家，文档让人往这儿放。
 * 2026-10-25 撤掉了一条候选（`~/.bili-ai/github.json`）：那是这台机器上别的插件共用的目录，
 * 对我方便，对陌生人等于「插件默认去翻别人家的凭据目录」。想复用就自己写 `tokenFile`。
 */
export const TOKEN_CANDIDATES = ['~/.dsh/github-token.json']


/** `~/x` 展开成真实路径；Windows 上 `~\x` 也认。 */
export function expandHome(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

function pickString(value, fallback = '') {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || fallback
}

/**
 * 数字配置：不是数字 → 默认值；数字但越界 → 夹到边界（「下限 20」就是夹到 20，不是丢掉）。
 * 这样 `pollMs=1000` 的人拿到 10000 而不是「插件不说话」。
 */
function clampInt(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  // 注意：`Number('')` 是 0，所以「没配」必须先判空再转数字，
  // 否则 undefined 会被当成 0 夹到下限（maxPages 会变成 1、pollMs 变成 10 秒）。
  if (value === undefined || value === null || typeof value === 'boolean') return fallback
  const text = typeof value === 'number' ? value : String(value).trim()
  if (text === '') return fallback
  const n = Number(text)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/**
 * 读 token 文件：`{ token, username }`。只读，永远不写、不打印。
 * 默认文件是 `~/.dsh/github-token.json`；仍然认旧文件里的 `benzi-game token` 字段
 * （历史兼容：`.bili-ai/github.json` 被几家插件共用，换了默认路径不代表不再认它）。
 * 读不到就是空字符串——调用方据此跳过这一轮并写日志，绝不抛。
 */
export function readTokenFile(file) {
  try {
    const raw = fs.readFileSync(expandHome(file), 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    return {
      token: String(j?.token || j?.['benzi-game token'] || '').trim(),
      username: String(j?.username || '').trim(),
    }
  } catch {
    return { token: '', username: '' }
  }
}

/**
 * 找 token：**先看环境变量 `GITHUB_TOKEN`**（CI 或临时用的人不想建文件），没有再依次试
 * `tokenFile` 与 `TOKEN_CANDIDATES`（同一个文件只试一次）。
 * 返回 `{ token, username, source }`；source 只给日志写「从哪来的」（相对 `~` 的短路径
 * 或 `GITHUB_TOKEN`），token 本身永远不打印。
 */
export function readToken({ tokenFile = DEFAULTS.tokenFile, env = process.env, candidates = TOKEN_CANDIDATES } = {}) {
  const fromEnv = String(env?.GITHUB_TOKEN || '').trim()
  const wanted = expandHome(tokenFile)
  const files = [tokenFile, ...candidates.filter((p) => expandHome(p) !== wanted)]
  const seenFiles = new Set()
  let firstUsername = ''

  for (const rel of files) {
    const abs = expandHome(rel)
    if (!abs || seenFiles.has(abs)) continue
    seenFiles.add(abs)
    const got = readTokenFile(abs)
    if (!firstUsername) firstUsername = got.username
    if (!got.token) continue
    if (fromEnv) break // 有环境变量就不再看文件，但 username 仍然从文件里取
    const shown = abs.startsWith(os.homedir())
      ? `~${path.sep}${path.relative(os.homedir(), abs)}`
      : abs
    return { token: got.token, username: got.username || firstUsername, source: fromEnv ? 'GITHUB_TOKEN' : shown }
  }

  if (fromEnv) return { token: fromEnv, username: firstUsername, source: 'GITHUB_TOKEN' }
  return { token: '', username: firstUsername, source: '' }
}

/**
 * 合并三源配置并做校验。纯函数（除了读 token 文件拿 username 默认值），测试可以直接调。
 * 返回的新对象**不含 token**——token 只在 index.js 里单独读一次，免得它出现在别处被顺手打出来。
 */
export function resolveConfig(raw = {}, { env = process.env, candidates = TOKEN_CANDIDATES } = {}) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const choose = (key) => {
    const fromConfig = given[key]
    if (fromConfig !== undefined && fromConfig !== null && String(fromConfig).trim() !== '') return fromConfig
    const name = ENV_KEYS[key]
    const fromEnv = name ? env[name] : undefined
    if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== '') return fromEnv
    return undefined
  }

  const repoGiven = String(choose('repo') ?? DEFAULTS.repo).trim()
  const repo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoGiven) ? repoGiven : DEFAULTS.repo

  const tokenFile = expandHome(pickString(choose('tokenFile'), DEFAULTS.tokenFile)) || DEFAULTS.tokenFile
  const sessionId = pickString(choose('sessionId'), DEFAULTS.sessionId)
  // deliverTo 不配就跟 sessionId；idleSession 不配就跟 deliverTo——于是「什么都不配」还是老行为，
  // 而「消息落到我聊天的会话、闸也盯那个会话」只要配一个 deliverTo。
  const deliverTo = pickString(choose('deliverTo'), '') || sessionId
  const idleSession = pickString(choose('idleSession'), '') || deliverTo
  const cwd = expandHome(pickString(choose('cwd'), DEFAULTS.cwd)) || expandHome(DEFAULTS.cwd)
  const mentionNames = String(pickString(choose('mentionNames'), DEFAULTS.mentionNames))
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  // login 默认从 token 文件的 username 来：不配也能过滤掉自己的发言。
  let login = pickString(choose('login'), '')
  if (!login) login = readToken({ tokenFile, env: {}, candidates }).username

  return {
    repo,
    tokenFile,
    login,
    sessionId,
    deliverTo,
    idleSession,
    mentionNames,
    mentions: mentionNames,
    cwd,
    pollMs: clampInt(choose('pollMs'), DEFAULTS.pollMs, { min: 10_000, max: 3_600_000 }),
    bootMs: clampInt(choose('bootMs'), DEFAULTS.bootMs, { min: 0, max: 3_600_000 }),
    idleMs: clampInt(choose('idleMs'), DEFAULTS.idleMs, { min: 0, max: 3_600_000 }),
    digestChars: clampInt(choose('digestChars'), DEFAULTS.digestChars, { min: 20, max: 500 }),
    digestMax: clampInt(choose('digestMax'), DEFAULTS.digestMax, { min: 3, max: 50 }),
    maxPages: clampInt(choose('maxPages'), DEFAULTS.maxPages, { min: 1, max: 30 }),
    logMaxBytes: clampInt(choose('logMaxBytes'), DEFAULTS.logMaxBytes, { min: 1024, max: 64 * 1024 * 1024 }),
    windows: parseWindows(pickString(choose('activeWindows'), DEFAULTS.activeWindows)),
    weekendAllDay: String(choose('weekendAllDay') ?? DEFAULTS.weekendAllDay).toLowerCase() !== 'false',
    sleepPollMs: clampInt(choose('sleepPollMs'), DEFAULTS.sleepPollMs, { min: 0, max: 6 * 3_600_000 }),
    callWakeMaxPerDay: clampInt(choose('callWakeMaxPerDay'), DEFAULTS.callWakeMaxPerDay, { min: 0, max: 10 }),
    burstMax: clampInt(choose('burstMax'), DEFAULTS.burstMax, { min: 1, max: 50 }),
    burstMs: clampInt(choose('burstMs'), DEFAULTS.burstMs, { min: 0, max: 6 * 3_600_000 }),
    afterUserMs: clampInt(choose('afterUserMs'), DEFAULTS.afterUserMs, { min: 0, max: 6 * 3_600_000 }),
  }
}

// HH:MM → 一天中的分钟数；写错就退回 fallback，不抛。
export function parseHM(value, fallback = '00:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (m) {
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h >= 0 && h <= 24 && mi >= 0 && mi < 60) return (h % 24) * 60 + mi
  }
  const f = /^(\d{1,2}):(\d{2})$/.exec(String(fallback).trim())
  return f ? (Number(f[1]) % 24) * 60 + Number(f[2]) : 0
}

// 现在是否落在活跃时段（分钟数区间列表）。
// 2026-10-28 换掉「一个静默窗」：主人要的是工作日两段、周末全天。跨零点的区间一律丢掉——
// 跨零点会让人分不清「熬夜」和「早起」，也就没法给「@ 叫醒」设一天几次的上限。
export function inActiveWindow(now, windows, weekendAllDay = true) {
  const dow = now.getDay() // 0 = 周日
  if (weekendAllDay && (dow === 0 || dow === 6)) return true
  const t = (now.getHours() * 60) + now.getMinutes()
  return (windows || []).some((w) => t >= w.start && t < w.end)
}

// 'HH:MM-HH:MM,HH:MM-HH:MM' → [{start,end}]（分钟）。写错的段整段丢掉，不抛。
export function parseWindows(value) {
  const out = []
  for (const part of String(value ?? '').split(',')) {
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part.trim())
    if (!m) continue
    const start = parseHM(m[1])
    // 24:00 要当一天结束（1440），不能落回 0——否则「18:00-24:00」会被当成跨零点丢掉。
    const end = m[2] === '24:00' ? 24 * 60 : parseHM(m[2])
    if (end <= start) continue // 跨零点或空区间：丢掉
    out.push({ start, end })
  }
  return out
}
