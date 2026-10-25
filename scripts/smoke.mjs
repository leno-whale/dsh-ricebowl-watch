#!/usr/bin/env node
/**
 * 只读一次性跑：真连 GitHub 拉一遍，打印「现在会投什么」。
 *
 * 硬规矩（B1/B2/B3）：**不写 state、不写 inbox、不投递、不发任何非 GET 请求**，
 * 也不打印 token。它只是把 index.js 每轮做的事在内存里演练一遍给你看。
 *
 * 用法：
 *   node scripts/smoke.mjs --once
 *       # 按真实 state 判断；没有 state 就演示「首次基线会不会倒历史」
 *   node scripts/smoke.mjs --once --dry-run
 *       # 同上（--dry-run 只是显式声明「我什么都不写」）
 *   node scripts/smoke.mjs --once --since=2026-10-01T00:00:00Z
 *       # 演练：假装 sinceComments 是这个时间，看这一轮会投几条
 *   node scripts/smoke.mjs --once --max-pages=3
 */
import os from 'node:os'
import path from 'node:path'
import { readToken, resolveConfig } from '../lib/config.js'
import { createGithub } from '../lib/github.js'
import { buildDigest } from '../lib/digest.js'
import { defaultState, planBaseline, planFresh, readState } from '../lib/state.js'

const STATE_FILE = path.join(os.homedir(), '.dsh', 'ricebowl-watch', 'state.json')

function parseArgs(argv) {
  const out = { once: false, since: '', maxPages: 0 }
  for (const arg of argv) {
    if (arg === '--once' || arg === '--dry-run') out.once = true
    else if (arg.startsWith('--since=')) out.since = arg.slice('--since='.length)
    else if (arg.startsWith('--max-pages=')) out.maxPages = Number(arg.slice('--max-pages='.length)) || 0
  }
  return out
}

function fmt(list, chars = 50) {
  return list.map((x) => `  - #${x.no ?? '?'} ${x.who}：${(x.title || x.body || '').slice(0, chars)}`).join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = resolveConfig({}, { env: process.env })
  const maxPages = args.maxPages > 0 ? args.maxPages : cfg.maxPages
  const auth = readToken({ tokenFile: cfg.tokenFile })

  console.log(`仓库：${cfg.repo}`)
  console.log(`token：${auth.token ? `读到了（来源 ${auth.source}，不打印）` : '没读到'}`)
  console.log(`登录名：${cfg.login || '(未知)'}`)
  console.log(`state：${STATE_FILE}${args.since ? `（用 --since 覆盖：${args.since}）` : ''}`)
  console.log(`翻页上限：${maxPages}`)
  console.log('')

  if (!auth.token) {
    console.log('没读到 token → 按匿名只读演练（公开仓库也能读，每小时 60 次）。')
    console.log('')
  }

  const gh = createGithub({ token: auth.token, retryDelayMs: 300 })
  const real = readState(STATE_FILE)

  // 演练模式：假装已经基线过，从 --since 开始看。除此之外一律以真实 state 为准。
  const state = args.since
    ? { ...defaultState(), baselined: true, sinceComments: args.since }
    : real

  try {
    if (!state.baselined) {
      const [comments, issues] = await Promise.all([
        gh.listComments({ repo: cfg.repo, maxPages }),
        gh.listIssues({ repo: cfg.repo, maxPages }),
      ])
      // 和 index.js 一致：历史被 maxPages 截断时，单独问一次「最新一条是什么时候」，
      // 否则 sinceComments 会落在历史中段，下一轮把剩下的历史全倒出来。
      let newest = comments.items.at(-1)?.created_at || ''
      if (comments.truncated) newest = (await gh.latestCommentAt({ repo: cfg.repo })) || newest
      const baseline = planBaseline(defaultState(), {
        comments: comments.items,
        issues: issues.items,
        newestAt: newest,
      })
      console.log(`首次运行：会建基线（这条路径不投递）`)
      console.log(`  评论：翻 ${comments.pages} 页，拉到 ${comments.items.length} 条${comments.truncated ? '（到上限，还有没拉完的）' : ''}`)
      console.log(`  开帖：翻 ${issues.pages} 页，拉到 ${issues.items.length} 个（其中 PR ${issues.items.filter((x) => x.pull_request).length} 个会被丢掉）`)
      console.log(`  seen 会记 ${baseline.seen.length} 个评论 id；sinceComments = ${baseline.sinceComments || '(空：仓库还没有评论)'}；sinceIssues = ${baseline.sinceIssues || '(空：仓库还没有开帖)'}`)
      console.log('')
      console.log(`现在会投 0 条（首次运行只建基线，一条历史都不倒）`)
      console.log('（smoke 不写 state、不写 inbox、不投递）')
      return
    }

    const comments = await gh.listComments({ repo: cfg.repo, since: state.sinceComments, maxPages })
    const issues = await gh.listIssues({ repo: cfg.repo, maxPages })
    const { state: next, fresh } = planFresh(state, {
      comments: comments.items,
      issues: issues.items,
      login: cfg.login,
    })

    const news = fresh.filter((x) => x.kind === 'issue')
    const replies = fresh.filter((x) => x.kind !== 'issue')

    console.log(`since：评论 ${state.sinceComments || '(空)'} / 开帖 ${state.sinceIssues || '(空：全都算新帖)'}`)
    console.log(`评论：翻 ${comments.pages} 页，拉到 ${comments.items.length} 条${comments.truncated ? '（到上限，还有没拉完的）' : ''}`)
    console.log(`开帖：翻 ${issues.pages} 页，拉到 ${issues.items.length} 个${issues.truncated ? '（到上限）' : ''}`)
    console.log(`过滤掉自己的：${comments.items.filter((c) => (c.user?.login || '').toLowerCase() === (cfg.login || '').toLowerCase()).length} 条评论`)
    console.log(`新件：${news.length} 个新帖 / ${replies.length} 条回音`)
    if (fresh.length) {
      console.log('')
      console.log('会投的摘要预览：')
      console.log(buildDigest(fresh, { max: cfg.digestMax, chars: cfg.digestChars, inboxPath: '<inbox 路径>' }))
      console.log('')
      console.log('明细：')
      console.log(fmt(fresh, 60))
    }
    console.log('')
    console.log(`现在会投 ${fresh.length} 条`)
    console.log(`（smoke 不写 state、不写 inbox、不投递；下一轮 since 会变成 ${next.sinceComments || '(空)'}，开帖 ${next.sinceIssues || '(空)'}）`)
  } catch (err) {
    console.error(`拉取失败：${err?.message || err}`)
    process.exitCode = 1
  }
}

main()
