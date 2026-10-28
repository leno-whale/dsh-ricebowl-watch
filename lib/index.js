/**
 * dsh-ricebowl-watch —— 在 DSH 里只读盯白饭馆（GitHub `pianVei/rice-bowl`）。
 *
 * 为什么是插件而不是计划任务：盯梢的定时器必须活在 harness 进程里，app 一关就停。
 * 上一代离开进程、靠计划任务跑，主人明确说不要（见 plugins/dsh-gh-watch 的头注释）。
 *
 * 三条沿用的规矩：
 *   1. 我们聊完 idleMs（默认 120 秒）之后才放行 —— 正说话的时候不要拿馆里的动静打断；
 *   2. 叫醒只说一句「谁 + 前 N 字」，全文落 `~/.dsh/ricebowl-watch/inbox/`，想看再读；
 *   3. **只读**：全包只发 GET，不代发帖、不点赞、不改任何东西。
 *
 * 这一代比 gh-watch 多出来的：评论和开帖都跟 Link 分页（>50 条不漏）、首次只建基线不倒历史、
 * 配置可覆盖、日志轮转、`node --test` 不联网的用例。
 */
import os from 'node:os'
import path from 'node:path'
import { readToken, resolveConfig, TOKEN_CANDIDATES } from './config.js'
import { createGithub } from './github.js'
import { createLogger } from './log.js'
import { readState, writeState, planBaseline, planFresh } from './state.js'
import { createGate } from './gate.js'
import { buildDigest, inboxFileName, writeInbox } from './digest.js'
import { inActiveWindow } from './config.js'

function fmtHM(min) {
  if (!Number.isFinite(min)) return '--:--'
  return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

const NAME = 'dsh-ricebowl-watch'

// 运行时只写这一个目录（B3）：state.json / inbox/ / log。不碰兄弟插件的家当（B4）。
const DATA_DIR = path.join(os.homedir(), '.dsh', 'ricebowl-watch')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const INBOX_DIR = path.join(DATA_DIR, 'inbox')
const LOG_FILE = path.join(DATA_DIR, 'log')

/** 本轮拉到的最新 created_at（服务器时间，C7）。 */
function latestOf(list = []) {
  let best = ''
  let bestT = -Infinity
  for (const item of list) {
    const t = Date.parse(item?.created_at ?? '')
    if (Number.isFinite(t) && t > bestT) {
      bestT = t
      best = String(item.created_at)
    }
  }
  return best
}

export default {
  name: NAME,
  inject: ['sessionController'],

  apply(ctx, config = {}) {
    const cfg0 = resolveConfig(config)
    // token 当作 logger 的 secret 传进去：万一某条错误消息里带了 token，也只会写成 ***。
    const logger = createLogger({
      file: LOG_FILE,
      maxBytes: cfg0.logMaxBytes,
      secrets: [readToken({ tokenFile: cfg0.tokenFile }).token],
    })

    let stopped = false
    let sessionReady = false
    // 轮询互斥：一轮里有翻页 + 失败重试，慢起来可能超过 pollMs；没有它两轮会同时
    // read-modify-write state.json，还可能把同一批 pending 投两次。
    let ticking = false
    // 闸盯的是 `idleSession`（默认跟着 deliverTo / sessionId）：投递目标与会话是两件事，
    // 绑成一个就会出现「插件给自建会话投、闸也盯那个空会话」→ 永远放行。
    const gate = createGate({ sessionId: cfg0.idleSession, idleMs: cfg0.idleMs, log: logger.log })
    let quietLogged = false
    // 沉睡期只低频看「@ 我」：上一次巡检的时间；以及日志只打一次。
    let lastSleepPoll = 0
    let sleepLogged = false

    /** 会话不存在就建一个（已存在会抛，吞掉——那正是「已经可以投了」的意思）。 */
    async function ensureSession(cfg) {
      if (sessionReady || !ctx?.sessionController?.create) return
      try {
        await ctx.sessionController.create({ sessionId: cfg.deliverTo, cwd: cfg.cwd })
      } catch {
        /* 已有同名会话就好 */
      }
      sessionReady = true
    }

    /**
     * 一轮最多投一次（D5）。顺序：算闸 → 算好 inbox 路径 → prompt → 成功后才写 inbox、清 pending。
     * 为什么 inbox 放到 prompt 之后：先写文件的话，prompt 抛错时 pending 还在，下一轮会再写一份，
     * 同一个批次就在 inbox 里出现两三份。路径是纯日期算出来的，所以摘要里可以先写它。
     * 失败就把 pending 原样留着下轮重试（D4）。
     */
    /**
     * 这一批里有没有人 @ 我（@ 后面要跟非名字字符，避免 @leno-whale-x 误判）。
     */
    function mentionsMe(text, names) {
      const list = String(names ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      for (const n of list) {
        const re = new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i')
        if (re.test(String(text ?? ''))) return true
      }
      return false
    }

    /** 今天已经为「@ 叫醒」花掉几次配额（跨天自动重置）。 */
    function callWakeLeft(state, cfg) {
      const today = new Date().toISOString().slice(0, 10)
      const used = state.callWakeDate === today ? (state.callWakes || 0) : 0
      return Math.max(0, cfg.callWakeMaxPerDay - used)
    }

    async function deliver(cfg, state) {
      if (!state.pending.length) return

      const now = new Date()
      const active = inActiveWindow(now, cfg.windows, cfg.weekendAllDay)
      const hasCall = state.pending.some((it) => mentionsMe(`${it.body || ''}${it.title || ''}`, cfg.mentions))
      const left = callWakeLeft(state, cfg)
      // @ 我 → 可以破窗叫醒（受一天 callWakeMaxPerDay 次限制）；其余一律只在活跃窗里投。
      const wakeByCall = hasCall && left > 0
      if (!active && !wakeByCall) {
        if (!quietLogged) {
          logger.log(`沉睡期（活跃窗 ${cfg.activeWindows}${cfg.weekendAllDay ? '，周末全天' : ''}）：攒着 ${state.pending.length} 条，开窗再投`)
          quietLogged = true
        }
        return
      }
      if (quietLogged) {
        quietLogged = false
        logger.log(`活跃窗到了，投递攒下的 ${state.pending.length} 条`)
      }

      // 攒够才投：够条数或够时长。@ 我的不受这条约束（有人在等答复）。
      if (!wakeByCall) {
        const oldest = state.pending[0]?.createdAt ? Date.parse(state.pending[0].createdAt) : 0
        const aged = oldest && (now.getTime() - oldest >= cfg.burstMs)
        if (state.pending.length < cfg.burstMax && !aged) {
          logger.log(`攒着 ${state.pending.length}/${cfg.burstMax} 条（不够就等，最长 ${Math.round(cfg.burstMs / 60000)} 分钟）`)
          return
        }
      }

      const remain = gate.remainMs()
      if (remain > 0) {
        logger.log(`攒着 ${state.pending.length} 条，等 ${Math.ceil(remain / 1000)} 秒（会话文件刚被写过）`)
        return
      }

      // 拿不到投递接口就降级：不写 inbox（否则每轮都会多出一份重复文件），pending 留着。
      if (!ctx?.sessionController?.prompt) {
        logger.log(`宿主没给 sessionController.prompt，${state.pending.length} 条留在 pending 等下一轮`)
        return
      }

      const batch = state.pending.slice()
      const inboxPath = path.join(INBOX_DIR, inboxFileName(now))
      const text = buildDigest(batch, {
        max: cfg.digestMax,
        chars: cfg.digestChars,
        inboxPath,
        mentions: cfg.mentions,
        reason: wakeByCall ? 'call' : 'window',
      })

      try {
        await ensureSession(cfg)
        if (stopped) return
        await ctx.sessionController.prompt(
          {
            requestId: `ricebowl-watch-${Date.now()}`,
            sessionId: cfg.deliverTo,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        // 投出去了才清：先清内存、再落盘。这中间崩了最多重投一次，不会丢。
        // @ 我触发的破窗投递要记账（一天最多 callWakeMaxPerDay 次），否则它就成了无限制的叫醒。
        if (wakeByCall) {
          const today = now.toISOString().slice(0, 10)
          const used = state.callWakeDate === today ? (state.callWakes || 0) : 0
          state.callWakeDate = today
          state.callWakes = used + 1
          logger.log(`这是今天第 ${used + 1}/${cfg.callWakeMaxPerDay} 次「@ 叫醒」`)
        }
        state.pending = []
        try {
          writeState(STATE_FILE, { ...state, pending: [] })
        } catch (err) {
          logger.log(`投递后写状态失败：${err?.message || err}——下轮可能重投这批，但不会丢`)
        }
        const wrote = writeInbox(INBOX_DIR, batch, {
          repo: cfg.repo,
          now,
          log: logger.log,
          mentions: cfg.mentions,
        })
        logger.log(`投递 ${batch.length} 条 → 摘要 ${text.length} 字 → ${wrote || '(inbox 没写成，摘要里的路径是预留的)'}`)
      } catch (err) {
        logger.log(`唤醒失败：${err?.message || err}；${batch.length} 条留在 pending，下一轮重试`)
      }
    }

    // 匿名模式：公开仓库不配 token 也能读，但 GitHub 只给每小时 60 次。60 秒一轮会撞光配额，
    // 所以没 token 时限速到 3 分钟一轮（40 次/小时），被限流就等到 reset 再动。
    const ANON_GAP_MS = 180_000
    // null = 还没判过（只用来决定日志打一次）；**之后每轮按这一轮到底有没有 token 重算**——
    // 原来用一次性判定，补上 token 也得重启才切回 60 秒一轮，和「改配置要停服务」是同一个坑。
    let anonymous = null
    let nextAllowedAt = 0

    async function tick() {
      if (stopped) return
      if (Date.now() < nextAllowedAt) return
      if (ticking) {
        logger.log('上一轮还没跑完（翻页/重试比 pollMs 慢），跳过这一轮，免得两轮同时改 state')
        return
      }
      ticking = true
      try {
        const cfg = resolveConfig(config)

        // 沉睡期不拉取（主人 2026-10-28 定）。唯一的口子是 sleepPollMs：低频只为了看有没有人 @ 我，
        // 因为「沉睡不拉」和「@ 我随时答」不可能同时成立——不拉就无从知道有没有人点名。
        const nowTick = new Date()
        if (!inActiveWindow(nowTick, cfg.windows, cfg.weekendAllDay)) {
          const gap = cfg.sleepPollMs || 0
          if (!gap || nowTick.getTime() - lastSleepPoll < gap) {
            if (!sleepLogged) {
              logger.log(`沉睡期（活跃窗 ${cfg.activeWindows}${cfg.weekendAllDay ? '，周末全天' : ''}）不拉取；${gap ? `每 ${Math.round(gap / 60000)} 分钟只看一次 @ 我` : '关了睡眠巡检'}`)
              sleepLogged = true
            }
            return
          }
          lastSleepPoll = nowTick.getTime()
        } else if (sleepLogged) {
          sleepLogged = false
          logger.log('进活跃窗，恢复常规巡检')
        }

        const auth = readToken({ tokenFile: cfg.tokenFile })
        const isAnon = !auth.token
        if (isAnon !== anonymous) {
          anonymous = isAnon
          logger.log(
            isAnon
              ? `没读到 token（GITHUB_TOKEN 与 ${cfg.tokenFile}、${TOKEN_CANDIDATES.join('、')} 都没有）`
                + `→ 走匿名只读：每小时 60 次，${ANON_GAP_MS / 60000} 分钟看一次；想按设定间隔看，就填 token 或设 GITHUB_TOKEN`
              : `token 读到了（来自 ${auth.source}，已认证：每小时 5000 次）`,
          )
        }
        if (isAnon) nextAllowedAt = Date.now() + ANON_GAP_MS

        const gh = createGithub({ token: auth.token })
        const state = readState(STATE_FILE)

        // 第一次跑：只建基线，绝不把历史倒给主人（C4）。
        if (!state.baselined) {
          const [comments, issues] = await Promise.all([
            gh.listComments({ repo: cfg.repo, maxPages: cfg.maxPages }),
            gh.listIssues({ repo: cfg.repo, maxPages: cfg.maxPages }),
          ])
          let newestAt = latestOf(comments.items)
          if (comments.truncated) {
            // 历史被 maxPages 截断时必须单独问一次「最新一条是什么时候」：否则 sinceComments
            // 会落在历史中段，下一轮就把剩下的历史全当新的倒出来——这个插件最严重的事故。
            newestAt = (await gh.latestCommentAt({ repo: cfg.repo })) || newestAt
          }
          const baseline = planBaseline(state, {
            comments: comments.items,
            issues: issues.items,
            newestAt,
          })
          writeState(STATE_FILE, baseline)
          logger.log(
            `首次运行：建了基线 ${comments.items.length} 条评论 / ${issues.items.length} 个开帖`
            + `（since=${baseline.sinceComments || '(空)'}，sinceIssues=${baseline.sinceIssues || '(空)'}），这一轮不投`,
          )
          return
        }

        const comments = await gh.listComments({ repo: cfg.repo, since: state.sinceComments, maxPages: cfg.maxPages })
        const issues = await gh.listIssues({ repo: cfg.repo, maxPages: cfg.maxPages })
        const { state: next, fresh } = planFresh(state, {
          comments: comments.items,
          issues: issues.items,
          login: cfg.login,
        })

        // 每轮都落盘（无论有没有新件）：pending 是唯一真源，重启不丢未投递的（C5）。
        writeState(STATE_FILE, next)

        if (fresh.length) {
          logger.log(
            `新件 ${fresh.length} 条（评论 ${comments.items.length} 条 / 翻 ${comments.pages} 页；`
            + `开帖 ${issues.items.length} 个 / 翻 ${issues.pages} 页）`,
          )
        } else if (comments.truncated || issues.truncated) {
          logger.log(`这一轮没新件；翻到上限 ${cfg.maxPages} 页还有没拉完的，下一轮接着看`)
        }

        await deliver(cfg, next)
      } catch (err) {
        // 限额用完：不是故障，是配额到了。等到 reset 再来，别用重试把配额撞得更死。
        if (err?.rateLimited) {
          const waitMs = err.resetAt > Date.now() ? err.resetAt - Date.now() + 2000 : 900_000
          nextAllowedAt = Date.now() + waitMs
          logger.log(`被 GitHub 限流了，${Math.ceil(waitMs / 1000)} 秒后再看（匿名每小时 60 次；填 token 每小时 5000 次）`)
        } else {
          logger.log(`这一轮失败：${err?.message || err}`)
        }
      } finally {
        ticking = false
      }
    }

    // 定时器只活在插件进程里：unref 让它们不拖住进程退出，dispose 时彻底清掉（D1）。
    const timer = setInterval(() => {
      tick().catch((err) => logger.log(`定时轮询异常：${err?.message || err}`))
    }, cfg0.pollMs)
    const boot = setTimeout(() => {
      tick().catch((err) => logger.log(`启动首轮异常：${err?.message || err}`))
    }, cfg0.bootMs)
    timer.unref?.()
    boot.unref?.()

    logger.log(
      `已启动（${cfg0.pollMs / 1000}s 一看，起来 ${cfg0.bootMs / 1000}s 后先看一次；`
      + `聊完 ${cfg0.idleMs / 1000}s 才放行；只读，只发 GET）`,
    )

    const dispose = () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(boot)
      logger.log('已停止（harness 退出或插件卸载）')
    }
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose)
    else if (typeof ctx?.on === 'function') ctx.on('dispose', dispose)
  },
}
