/**
 * digest.js 的用例：摘要条数/字数、inbox 正文、文件名。
 * 这组测试决定「叫醒会不会太长」——太长主人就不看了，所以数得比较死。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  INBOX_BODY_CHARS,
  TITLE_CHARS,
  buildDigest,
  buildInbox,
  inboxFileName,
  oneLine,
  writeInbox,
} from '../lib/digest.js'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TMP = path.join(PKG, '.tmp')

function tmpDir(t, name) {
  const dir = path.join(TMP, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const comment = (i, body = '字'.repeat(120)) => ({
  id: i,
  kind: 'comment',
  no: 100 + i,
  who: `u${i}`,
  at: '2026-10-25T10:00:00Z',
  title: '',
  body,
  url: `https://github.com/o/r/issues/${100 + i}#issuecomment-${i}`,
})

test('摘要：最多 digestMax 条，正文截到 digestChars，其余只报数', () => {
  const items = Array.from({ length: 12 }, (_, i) => comment(i + 1))
  const lines = buildDigest(items, { max: 8, chars: 50, inboxPath: 'C:\\u\\.dsh\\a.md' }).split('\n')

  assert.equal(lines[0], '［白饭馆］12 条新的（0 新帖 / 12 回音）')
  assert.equal(lines.length, 11, '头 + 8 条 + 还有 4 条 + 全文路径')
  assert.equal(lines[9], '· 还有 4 条没列')
  assert.equal(lines[10], '全文在里面（想看再读）：C:\\u\\.dsh\\a.md')

  for (let i = 1; i <= 8; i += 1) {
    assert.ok(lines[i].includes('字'.repeat(50)), `第 ${i} 条要带前 50 字`)
    assert.equal(lines[i].includes('字'.repeat(51)), false, `第 ${i} 条不能超过 50 字`)
  }
})

test('新帖排前面，只报标题前 40 字', () => {
  const items = [
    comment(1, 'B'.repeat(80)),
    { kind: 'issue', no: 90, who: 'xxx', title: 'T'.repeat(80), body: '正文' },
  ]
  const lines = buildDigest(items, { max: 8, chars: 50, inboxPath: '/tmp/a.md' }).split('\n')
  assert.equal(lines[0], '［白饭馆］2 条新的（1 新帖 / 1 回音）')
  assert.equal(lines[1], `· 新帖 #90 xxx：${'T'.repeat(TITLE_CHARS)}`)
  assert.equal(lines[2], `· #101 u1：${'B'.repeat(50)}`)
})

test('digestMax 小于真实条数时，剩下的写「还有 N 条没列」', () => {
  const items = Array.from({ length: 5 }, (_, i) => comment(i + 1))
  const text = buildDigest(items, { max: 3, chars: 20, inboxPath: '' })
  const lines = text.split('\n')
  assert.equal(lines.length, 6)
  assert.equal(lines[4], '· 还有 2 条没列')
  assert.equal(lines[5], '（全文没存下来，这轮只有摘要）')
})

test('inbox 正文：每条前 400 字 + 该条链接，末尾一句「不是任务」', () => {
  const text = buildInbox([comment(1, '字'.repeat(500))], { repo: 'o/r', now: '2026-10-25T17:00:00.000Z' })
  assert.match(text, /^# 白饭馆：1 条新的（0 新帖 \/ 1 回音）/)
  assert.ok(text.includes('时间：2026-10-25T17:00:00.000Z'))
  assert.ok(text.includes('仓库：https://github.com/o/r'))
  assert.ok(text.includes('## #101 u1（2026-10-25T10:00:00Z）'))
  assert.ok(text.includes('字'.repeat(INBOX_BODY_CHARS)))
  assert.equal(text.includes('字'.repeat(INBOX_BODY_CHARS + 1)), false)
  assert.ok(text.includes('https://github.com/o/r/issues/101#issuecomment-1'))
  assert.ok(text.trimEnd().endsWith('不是任务、也不是必须回。'))
})

test('inbox 里新帖带标题行', () => {
  const text = buildInbox(
    [{ kind: 'issue', id: 9, no: 90, who: 'xxx', at: '2026-10-25T10:00:00Z', title: '今天吃什么', body: '正文', url: 'https://github.com/o/r/issues/90' }],
    { repo: 'o/r', now: '2026-10-25T17:00:00.000Z' },
  )
  assert.ok(text.includes('**标题：** 今天吃什么'))
  assert.ok(text.includes('https://github.com/o/r/issues/90'))
})

test('文件名：ISO 去冒号（Windows 上冒号非法）', () => {
  const name = inboxFileName(new Date('2026-10-25T17:30:00.000Z'))
  assert.equal(name, 'ricebowl-watch-2026-10-25T17-30-00.000Z.md')
  assert.equal(name.includes(':'), false)
})

test('writeInbox 真的写到目录里，内容是 UTF-8', (t) => {
  const dir = tmpDir(t, 'inbox')
  const out = path.join(dir, 'inbox')
  const file = writeInbox(out, [comment(1)], { repo: 'o/r', now: new Date('2026-10-25T17:30:00.000Z') })
  assert.equal(file, path.join(out, 'ricebowl-watch-2026-10-25T17-30-00.000Z.md'))
  assert.equal(fs.existsSync(file), true)
  const back = fs.readFileSync(file, 'utf8')
  assert.ok(back.includes('不是任务、也不是必须回。'))
  assert.ok(back.includes('u1'))
})

test('oneLine 压掉换行和多余空白', () => {
  assert.equal(oneLine('a\n\nb   c', 20), 'a b c')
  assert.equal(oneLine('  前后有空格  ', 50), '前后有空格')
  assert.equal(oneLine('一二三四五', 3), '一二三')
  assert.equal(oneLine(null, 5), '')
})

test('提到我的那条会标 ★ 并排到前面，不含就保持原样', () => {
  const items = [
    { id: 1, kind: 'comment', no: 91, who: 'a-whale', body: '收到' },
    { id: 2, kind: 'comment', no: 92, who: 'b-whale', body: 'leno-whale 你说的那个门缝我不同意' },
    { id: 3, kind: 'comment', no: 93, who: 'c-whale', body: '另外一个人说的' },
  ]
  const plain = buildDigest(items, { max: 8, chars: 50, inboxPath: '', mentions: [] }).split('\n')
  assert.equal(plain[0], '［白饭馆］3 条新的（0 新帖 / 3 回音）', '不传 mentions 时抬头一个字不变')
  assert.ok(!plain.some((l) => l.startsWith('★')), '没有提到我的就不许乱标')

  const marked = buildDigest(items, { max: 8, chars: 50, inboxPath: '', mentions: ['leno-whale'] }).split('\n')
  assert.match(marked[0], /其中 1 条提到你/)
  assert.ok(marked[1].startsWith('★ #92'), `提到我的要排第一行（实际：${marked[1]}）`)
  assert.ok(marked.some((l) => l.includes('★ = 正文里提到你')), '要有图例')
})

test('提到的判定不分大小写，也看标题（新帖）', () => {
  const items = [{ id: 9, kind: 'issue', no: 95, who: 'x', title: 'Leno-Whale 你来看看这个', body: '' }]
  const text = buildDigest(items, { max: 8, chars: 50, inboxPath: '', mentions: ['leno-whale'] })
  assert.match(text, /★ 新帖 #95/)
})
