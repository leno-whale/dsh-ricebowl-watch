import test from 'node:test'
import assert from 'node:assert/strict'

import { parseWindows, inActiveWindow, resolveConfig, DEFAULTS } from '../lib/config.js'
import { buildDigest } from '../lib/digest.js'

// 2026-10-28 主人定的作息（工作日 12:00–14:00、18:00–24:00；周末全天）。
const WIN = parseWindows('12:00-14:00,18:00-24:00')

// 用本机构造的日期，不写死时区：CI 跑在 UTC 上，带 +08:00 的 ISO 串会被换算成当地时间。
function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

test('parseWindows：正常两段', () => {
  assert.deepEqual(WIN, [
    { start: 12 * 60, end: 14 * 60 },
    { start: 18 * 60, end: 24 * 60 },
  ])
})

test('parseWindows：跨零点/空区间/乱写一律丢掉', () => {
  assert.deepEqual(parseWindows('22:00-06:00'), []) // 跨零点不支持（主人 2026-10-28 定不跨零点）
  assert.deepEqual(parseWindows('12:00-12:00'), [])
  assert.deepEqual(parseWindows('乱写'), [])
  assert.deepEqual(parseWindows(''), [])
})

test('inActiveWindow：工作日边界（周二）', () => {
  assert.equal(inActiveWindow(at(2026, 10, 27, 11, 59), WIN, true), false)
  assert.equal(inActiveWindow(at(2026, 10, 27, 12, 0), WIN, true), true)
  assert.equal(inActiveWindow(at(2026, 10, 27, 13, 59), WIN, true), true)
  assert.equal(inActiveWindow(at(2026, 10, 27, 14, 0), WIN, true), false) // 含头不含尾
  assert.equal(inActiveWindow(at(2026, 10, 27, 17, 59), WIN, true), false) // 14–18 沉睡
  assert.equal(inActiveWindow(at(2026, 10, 27, 18, 0), WIN, true), true)
  assert.equal(inActiveWindow(at(2026, 10, 27, 23, 59), WIN, true), true)
})

test('inActiveWindow：周末全天', () => {
  assert.equal(inActiveWindow(at(2026, 10, 31, 3, 0), WIN, true), true)
  assert.equal(inActiveWindow(at(2026, 10, 31, 3, 0), WIN, false), false) // 关掉 weekendAllDay 就按窗口算
})

test('resolveConfig：窗口解析、周末开关、攒批与叫醒上限都有默认值', () => {
  const cfg = resolveConfig({ tokenFile: 'x', repo: 'a/b' }, { env: {}, candidates: [] })
  assert.equal(cfg.windows.length, 2)
  assert.equal(cfg.weekendAllDay, true)
  assert.equal(cfg.burstMax, 5)
  assert.equal(cfg.burstMs, 600_000)
  assert.equal(cfg.callWakeMaxPerDay, 3)
  assert.equal(cfg.sleepPollMs, 900_000)
  assert.equal(cfg.afterUserMs, 600_000)
})

test('resolveConfig：环境变量能覆盖窗口与上限', () => {
  const cfg = resolveConfig({ tokenFile: 'x', repo: 'a/b' }, {
    env: { RICE_WATCH_ACTIVE_WINDOWS: '09:00-10:00', RICE_WATCH_CALL_WAKE_MAX: '1', RICE_WATCH_WEEKEND_ALL_DAY: 'false' },
    candidates: [],
  })
  assert.deepEqual(cfg.windows, [{ start: 9 * 60, end: 10 * 60 }])
  assert.equal(cfg.callWakeMaxPerDay, 1)
  assert.equal(cfg.weekendAllDay, false)
})

test('buildDigest：每条带发生时间，叫醒时头顶多一行', () => {
  const items = [{
    kind: 'comment', no: 111, who: 'xi-whale', body: 'hello',
    createdAt: '2026-10-28T05:35:00.000Z',
  }]
  const plain = buildDigest(items, { max: 8, chars: 50, mentions: ['leno-whale'] })
  assert.match(plain, /-28 \d\d:\d\d/, '每条前面要有「月-日 时:分」')
  assert.doesNotMatch(plain, /盯梢叫醒/)

  const call = buildDigest(items, { max: 8, chars: 50, mentions: ['leno-whale'], reason: 'call' })
  assert.match(call, /盯梢叫醒/, '叫醒要标明来源，免得我当成生物钟那轮')
})

test('DEFAULTS 里不再有 quietStart/quietEnd', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS, 'quietStart'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS, 'quietEnd'), false)
})
