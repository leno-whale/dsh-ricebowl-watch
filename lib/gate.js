/**
 * 会话尾指纹放行闸（D2）：聊完 idleMs 才允许叫醒。
 *
 * 为什么不用 mtime：harness 会定期把会话文件冲盘（内容其实没变），mtime 一被碰掉，
 *   闸就永远差 idleMs 秒 —— 表现是「消息永远不来」。上一代 gh-watch 踩过。
 * 为什么不用纯长度：日志自己会长（馆长 #78 的原话），长度一变就以为是新发言，
 *   同样会把闸一直重置。也要否掉。
 * 所以看**尾部指纹**：`size + sha1(最后 4KB).slice(0,12)`。
 *   只有真的写了新内容，后 4KB 才会变；冲盘、append 空行之外的东西都不会误判。
 *
 * 会话文件按 `~/.dsh/sessions/<cwd 编码>/<sessionId>/session.v4*` 找，取第一个匹配；
 * 找不到或读失败 → **放行**（返回 0）。宁可早叫一次，也不能因为找不到文件把投递卡死。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 尾部 4KB 的 sha1 + 文件大小。文件不存在会抛，由调用方兜。 */
export function tailFingerprint(file) {
  const size = fs.statSync(file).size
  const len = Math.min(4096, size)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(file, 'r')
  try {
    if (len > 0) fs.readSync(fd, buf, 0, len, size - len)
  } finally {
    fs.closeSync(fd)
  }
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)
  return `${size}:${hash}`
}

/** 逐层 glob：sessions/<任意 cwd 编码>/<sessionId>/session.v4*，取第一个匹配。 */
export function findSessionFile({ home = path.join(os.homedir(), '.dsh'), sessionId } = {}) {
  const root = path.join(home, 'sessions')
  let dirs = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return ''
  }
  for (const dir of dirs) {
    const sessionDir = path.join(root, dir, String(sessionId || ''))
    let names = []
    try {
      names = fs.readdirSync(sessionDir)
    } catch {
      continue
    }
    const hit = names.find((n) => n.startsWith('session.v4'))
    if (hit) return path.join(sessionDir, hit)
  }
  return ''
}

/**
 * 建一个闸。状态是进程级闭包（每进程维护 lastFp + lastGrowAt，第 8 节）。
 *
 * @param {{
 *   sessionId: string, idleMs: number, home?: string,
 *   log?: (msg: string) => void, now?: () => number, cacheMs?: number,
 * }} opts
 */
export function createGate({
  sessionId,
  idleMs,
  home = path.join(os.homedir(), '.dsh'),
  log = () => {},
  now = () => Date.now(),
  cacheMs = 60_000,
} = {}) {
  const idle = Number.isFinite(Number(idleMs)) ? Math.max(0, Number(idleMs)) : 0
  let lastFp = ''
  let lastGrowAt = 0
  let cachedPath = ''
  let cachedAt = 0
  let warnedMissing = false

  // 建闸时先记一次指纹，并把「上次长大」压到 idle 之前：
  // 否则第一次 remainMs() 必然发现指纹变了 → 白等一个 idleMs，表现是「装好后第一轮总被推迟 2 分钟」。
  // 文件不存在就保持空指纹，等它出现时再按「刚有人说话」算（那才是真的新内容）。
  {
    cachedPath = findSessionFile({ home, sessionId })
    cachedAt = now()
    if (cachedPath) {
      try {
        lastFp = tailFingerprint(cachedPath)
        lastGrowAt = now() - idle
      } catch {
        /* 读不到就当没有，第一次 remainMs 会重新判断 */
      }
    }
  }

  function sessionFile() {
    const t = now()
    if (cachedPath && t - cachedAt < cacheMs) {
      try {
        if (fs.statSync(cachedPath).isFile()) return cachedPath
      } catch {
        /* 文件被换成别的编码目录了，重新找 */
      }
    }
    cachedPath = findSessionFile({ home, sessionId })
    cachedAt = t
    return cachedPath
  }

  /** 距离可以放行还差多少毫秒；<=0 表示现在可以叫。 */
  function remainMs() {
    const file = sessionFile()
    if (!file) {
      if (!warnedMissing) {
        warnedMissing = true
        log(`没找到会话文件（sessions/*/${sessionId}/session.v4*），这轮放行——卡在这里比早叫一次更糟`)
      }
      return 0
    }
    try {
      const fp = tailFingerprint(file)
      const t = now()
      if (fp !== lastFp) {
        // 有人刚写了会话文件：从现在开始重新计时。
        lastFp = fp
        lastGrowAt = t
        return idle
      }
      const remain = idle - (t - lastGrowAt)
      return remain > 0 ? remain : 0
    } catch (err) {
      if (!warnedMissing) {
        warnedMissing = true
        log(`读会话文件失败（${err?.message || err}），这轮放行`)
      }
      return 0
    }
  }

  return { remainMs, sessionFile }
}
