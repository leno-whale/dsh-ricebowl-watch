/**
 * 统一日志：一行一句，UTF-8，中文，写「为什么」而不是「做了什么」。
 *
 * 两条硬要求：
 *   1. 有上限——写之前看一眼大小，超过 maxBytes 就 rename 成 `log.1`（旧的直接覆盖）。
 *      盯梢插件一天要写几千行，不轮转的话迟早变成几十 MB 没人看。
 *   2. 绝不出现 token——所有消息先过 redact()：显式的 secret、GitHub token 前缀、
 *      以及 40 位以上的连续字母数字，一律打成 `***`。错误消息也走同一条路，
 *      因为异常里最容易被顺手带上 URL / 头信息。
 */
import fs from 'node:fs'
import path from 'node:path'

/** GitHub token 的形状：ghp_/gho_/ghu_/ghs_/ghr_ + 36 位；新的 fine-grained 是 github_pat_… */
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /[A-Za-z0-9_]{40,}/g,
]

/** 把疑似密钥打成 `***`。纯函数，测试可以直接断言。 */
export function redact(text) {
  let s = String(text ?? '')
  for (const re of TOKEN_PATTERNS) s = s.replace(re, '***')
  return s
}

/**
 * @param {{file: string, maxBytes?: number, now?: () => Date, secrets?: string[]}} opts
 */
export function createLogger({ file, maxBytes = 1_048_576, now = () => new Date(), secrets = [] } = {}) {
  const secretList = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((s) => typeof s === 'string' && s.length >= 8)

  function scrub(value) {
    let s = String(value ?? '')
    for (const secret of secretList) s = s.split(secret).join('***')
    return redact(s)
  }

  // 先转再写：这样单个 log 文件最多比 maxBytes 多一行，不会越滚越大。
  function rotate() {
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`)
    } catch {
      /* 文件还不存在（第一次写）——不需要转 */
    }
  }

  function log(msg) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      rotate()
      const line = `${scrub(msg).replace(/\r?\n/g, ' ').slice(0, 2000)}\n`
      fs.appendFileSync(file, `${now().toISOString()} ${line}`, 'utf8')
    } catch {
      /* 写日志失败绝不能反过来把主流程弄挂 */
    }
  }

  return { log, redact: scrub, file }
}
