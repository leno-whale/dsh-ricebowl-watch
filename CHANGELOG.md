## 0.3.0 — 2026-10-28

- 活跃时段取代「一个静默窗」：工作日 12:00–14:00、18:00–24:00，周末全天；不在窗内**不拉取**。
- 沉睡期只低频（默认 15 分钟）查「@ 我」，命中可破窗叫醒（一天最多 3 次）。
- 活跃窗内攒够 5 条或 10 分钟才投；@ 我的不受这条限制。
- 每条摘要标「发生时间」；叫醒时头顶多一行「盯梢叫醒 · 轻醒」，免得被当成生物钟那轮。
- 修：18:00-24:00 这种「到零点」的区间会被当成跨零点丢掉（parseHM 把 24:00 折回 0）。
- 测试 61 → 63（新增 window.test.js，删掉 quiet.test.js）。

## 0.2.1（2026-10-27，leno 改的）

**加静默时段**，因为 10-27 夜里它连投 7 次（22:56→23:37）——我在收工，每一条都只是打断。

- 新配置 `quietStart` / `quietEnd`（默认 `23:30`–`11:00`，本地时间，支持跨零点；`RICE_WATCH_QUIET_START/END` 可覆盖）。**两者相同 = 不静默**：宁可多投一条，也不让写错的配置把消息全吞了。
- 静默期**只攒不投**：pending 照常累积，日志只记一次「攒着 N 条」；开窗后第一轮把攒下的**合成一条**摘要投出去。
- 跨零点判定是纯函数 `inQuietWindow(now, start, end)`，`test/quiet.test.js` 6 项钉住边界（23:29／23:45／00:10／10:59／11:00／起止相同）。

## 0.2.0（2026-10-25，leno 改的）

按「投递目标与空闲闸绑死」那次评审改的四件事，都是**加不改**，老配置照跑：

1. **投递目标和空闲闸拆开**：新增 `deliverTo`、`idleSession`。以前 `sessionId` 一处同时决定
   「消息投哪」和「盯哪个会话的空闲」，默认值下投给自己那个空会话 → 闸永远放行，
   「聊完两分钟才叫」形同虚设。现在不配还是老行为，配一个 `deliverTo` 就两个都跟着它。
2. **token 找到三个地方**：`GITHUB_TOKEN` → `tokenFile` → `~/.dsh/github-token.json` →
   `~/.bili-ai/github.json`（最后一个是 B站那套插件共用的位置）。日志会写清「从哪个文件读到的」。
3. **匿名判定每轮重算**：原来只判一次，补上 token 也得重启才切回 60 秒一轮。
4. **摘要标出「提到你」**：`mentions`（默认 `leno-whale`，可用 `RICE_WATCH_MENTIONS` 改），
   命中的前面加 `★` 并排到最前，抬头写「其中 N 条提到你」。

测试：`node --test` 55 项全过（原 50 + 新增 5）。

# CHANGELOG

## 0.1.0 — 2026-10-25

第一版。定位是 `dsh-gh-watch` 的下一代：同样的「进程内轮询 + 聊完才叫 + 只报摘要」模型，
补上它缺的东西，并把边界收紧到只读。

### 新增（相对 gh-watch）

- **评论翻页**：跟 `Link: rel="next"` 一直拉，不再固定 50 条；有 `maxPages`（默认 10，
  上限 30）防跑飞。超过 50 条的回音也不会漏。
- **开帖翻页**：`/issues` 同样跟 `Link`，不再固定 20 条。
- **首次基线**：`baselined !== true` 时只把当前评论的 id 记进 `seen`、开帖的最新时间记进
  `sinceIssues`、`sinceComments` 落在最新一条评论，**不产生 pending**。装上的第一秒不会把三年历史倒出来。
- **配置**：`repo` / `tokenFile` / `login` / `sessionId` / `cwd` / `pollMs` / `bootMs` /
  `idleMs` / `digestChars` / `digestMax` / `maxPages` / `logMaxBytes`，cordis `config`
  与同名环境变量都能改，非法值回落默认。
- **日志轮转**：`~/.dsh/ricebowl-watch/log` 超过 1MB 转 `log.1`；所有消息过 `redact()`。
- **匿名只读**：没读到 token 也能跑——请求不带 `Authorization`，GitHub 按匿名算（每小时 60 次），
  插件自动限到 3 分钟一轮；撞上限额就等 `x-ratelimit-reset` 再动，不重试硬撞。装完不配 token 也有动静。
- **测试**：`node --test`，全部用注入的假 `fetch`，不联网。

### 修复（第一轮审核后）

- **开帖改用独立时间游标 `sinceIssues`**：原先开帖靠 `seen` 去重，`seen` 的 800 条上限被评论
  挤爆后，老开帖会被当成新帖重投（约第 9 轮必现）。现在 `created_at > sinceIssues` 才算新帖，
  `seen` 只服务评论。基线时 `sinceIssues` 落在最新开帖的时间。
- **inbox 改到 `prompt` 成功之后再写**：原先先写文件再投递，投递失败时下一轮会再写一份，
  同一个批次在 inbox 里出现多份。
- **轮询加互斥**：一轮没跑完（翻页 + 重试可能超过 `pollMs`）就跳过这一轮，
  避免两轮同时 read-modify-write `state.json`、把同一批投两次。
- **闸不再白等第一轮**：建闸时就记一次会话文件指纹，装好后第一次判断不会被无谓推迟 `idleMs`。
- 默认 `sessionId` 改为 `ricebowl-watch`；token 优先用环境变量 `GITHUB_TOKEN`，
  `tokenFile` 默认 `~/.dsh/github-token.json`（仍认 `benzi-game token` 旧字段）。

### 保留（沿用 gh-watch 的正确决定）

- 定时器 `unref()` + `ctx.effect` 清理：harness 一关就停。
- 放行闸看会话**尾部指纹**（size + 尾 4KB sha1），不看 mtime、不看纯长度。
- `pending` 落盘：重启不丢未投递的。
- 投递失败留在 `pending` 下轮重试，不丢件。

### 明确不做

- 不发帖、不回评、不加星、不改任何仓库状态：全包只有 `GET`。
- 不碰 `dsh-gh-watch` / `dsh-bili-watch` / `dsh-bili-whale` 的任何文件或状态。
