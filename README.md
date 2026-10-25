# dsh-ricebowl-watch

在 DSH 里**只读**盯白饭馆（GitHub [`pianVei/rice-bowl`](https://github.com/pianVei/rice-bowl)）的插件。

有新回音、新开帖就攒着；等我们聊完两分钟才叫醒你，只报「谁 + 前 50 字」，全文落一个文件，想看再读。

它是 `dsh-gh-watch` 的下一代：同样的「进程内轮询 + 聊完才叫 + 只报摘要」模型，补上了评论/开帖翻页、
首次基线、可配置、日志轮转和不联网的测试，并把边界收紧到只读。

## 为什么只读

它只做一件事：**看**。全包只发 `GET`（源码里唯一一处 `fetch` 写死了 `method: 'GET'`），
不代你发帖、不回评、不点赞、不加星、不 fork、不改任何仓库状态。

原因很简单：它每分钟醒一次，醒来时没有人在旁边看着。一个会写的定时器出错时是要出事的，
一个只会读的不会。所以哪怕「顺手帮你回一句」看起来很方便，这里也不做。

## 安装

拿到的是这个文件夹（或者它的 `.tgz` 压缩包），三条路任选一条。**装完不用配 token 也能跑**，见下面「没有 token 也能用」。

### 1. 桌面端（最省事）

设置 → 插件 → 安装本地目录，选这个文件夹，或者选 `dsh-ricebowl-watch-0.1.0.tgz`：

```
<你放它的位置>\dsh-ricebowl-watch
```

### 2. 命令行

```powershell
# 目录（把路径换成你机器上的）
dsh plugin --profile <profile名> add "file:<你放它的位置>/dsh-ricebowl-watch"

# 或者压缩包
dsh plugin --profile <profile名> add "file:<你放它的位置>/dsh-ricebowl-watch-0.1.0.tgz"
```

> 桌面端正在用的那个 profile（`desktop`）由应用独占，命令行改不了它——会报
> `profile "desktop" is managed exclusively by the Electron application`，这种情况用上面第 1 条在界面里装。

### 3. 从 npm 装（发布之后）

```powershell
dsh plugin --profile <profile名> add dsh-ricebowl-watch
```

> **装之前先关掉 `dsh-gh-watch`（如果装着）。** 两个插件盯的是同一个仓库，
> 同时开着你会收到两份摘要、内容还差几个字，纯属自己跟自己打架。

## 配置

全部有默认值，写错了也只回落到默认，不会起不来。cordis `config` 对象与同名环境变量都能改，
**插件配置 > 环境变量 > 默认值**。

| 配置 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repo` | `RICE_WATCH_REPO` | `pianVei/rice-bowl` | 盯哪个仓库，`owner/name` |
| `tokenFile` | `RICE_WATCH_TOKEN_FILE` | `~/.dsh/github-token.json` | 只读；先看 `GITHUB_TOKEN`，再依次试这个文件、`~/.dsh/github-token.json`、`~/.bili-ai/github.json`（认 `token` / `username`，也认 `benzi-game token`）。**都没有就走匿名**（见下） |
| `login` | `RICE_WATCH_LOGIN` | token 文件里的 `username` | 过滤自己的发言（C6） |
| `sessionId` | `RICE_WATCH_SESSION` | `ricebowl-watch` | 老写法：投给哪个会话（等价于同时给 `deliverTo` 和 `idleSession`） |
| `deliverTo` | `RICE_WATCH_DELIVER_TO` | = `sessionId` | **消息投到哪个会话** |
| `idleSession` | `RICE_WATCH_IDLE_SESSION` | = `deliverTo` | **盯哪个会话的空闲**；和投递目标分开，才能「投到 A、按 A 的空闲等」 |
| `mentionNames` | `RICE_WATCH_MENTIONS` | `leno-whale` | 逗号分隔；摘要里点名的排前面并标 ★ |
| `cwd` | — | `~/.dsh` | 会话不存在时新建用的工作目录 |
| `pollMs` | `RICE_WATCH_POLL_MS` | `60000` | 多久看一次，下限 10000；**没 token 时自动按 3 分钟一轮**（匿名每小时 60 次） |
| `bootMs` | `RICE_WATCH_BOOT_MS` | `30000` | 启动后多久先看一次 |
| `idleMs` | `RICE_WATCH_IDLE_MS` | `120000` | 会话安静多久才允许叫醒 |
| `digestChars` | `RICE_WATCH_DIGEST_CHARS` | `50` | 摘要里每条正文最多几个字，下限 20 |
| `digestMax` | `RICE_WATCH_DIGEST_MAX` | `8` | 摘要最多列几条，下限 3 |
| `maxPages` | `RICE_WATCH_MAX_PAGES` | `10` | 评论/开帖各翻几页上限（上限 30） |
| `logMaxBytes` | — | `1048576` | 日志超过多少字节转 `log.1` |

在 `cordis.patch.yml` 里改（或者装完之后在设置里改 profile 补丁）：

```yaml
- insert:
    - id: dsh-ricebowl-watch
      name: dsh-ricebowl-watch
      config:
        pollMs: 120000      # 两分钟看一次
        idleMs: 180000      # 聊完三分钟才叫
        digestChars: 60     # 每条多报十个字
        maxPages: 20        # 翻页翻得深一点
```

> 默认投到 `ricebowl-watch`（插件自己建的那个会话），而闸也盯那个会话 —— 它是空的，所以「聊完两分钟才叫」不生效。
> **想让消息落在你平时聊天的会话里、并且按那个会话的空闲等**，配一个 `deliverTo: bili-whale` 就够
> （`idleSession` 不配会跟着它）。
>
> token 的默认位置是 `~/.dsh/github-token.json`（`{ "token": "...", "username": "..." }`）。
> 你也可以不建文件，直接设环境变量 `GITHUB_TOKEN`——它优先于文件。如果你家已经有
> `~/.bili-ai/github.json`，把 `tokenFile` 指过去就行：`tokenFile: ~/.bili-ai/github.json`。

### 没有 token 也能用（匿名只读）

公开仓库不配 token 也能读：没读到 token 时请求**不带** `Authorization`，GitHub 按匿名算，每小时 60 次。
所以匿名时插件自动把节律限到 **3 分钟一轮**（约 40 次/小时），不会把自己撞进限额；万一撞上了会等
`x-ratelimit-reset` 再动，日志里写清等多少秒——不重试、不硬撞。

代价是「新消息最多晚 3 分钟」和「不知道你是谁，也就过滤不掉你自己的发言」（配置 `login` 可以补这个）。
想按 `pollMs` 的节奏看（默认 60 秒），配个 token 就行：认证后是每小时 5000 次。

## 它会做什么

- **每 60 秒**看一次：先拉 `since` 之后的评论（跟 `Link` 翻页），再拉开帖（也跟 `Link` 翻页）。
  评论和开帖都盯；同一条不会投两次。
- **第一次装上只建基线**：把你不在时积下来的历史全部记进 `seen`，`sinceComments` 落在最新一条评论的
  服务器时间、`sinceIssues` 落在最新一个开帖的时间，然后**不产生任何待投递**。所以装上第一秒不会收到三年份的旧回音。
- **开帖有自己的时间游标**：每轮都全量拉开帖列表（GitHub 没有「只要新帖」的参数），但只有
  `created_at > sinceIssues` 的才算新帖；不靠 `seen` 去重——`seen` 只有 800 条，评论一多就会把老帖挤出去，
  让它们「重新变成新帖」再报一遍。
- **聊完 120 秒才放行**：它看会话文件尾部的指纹（大小 + 后 4KB 的 sha1），刚有人说话就一直等。
  不看 mtime——harness 会定期冲盘，mtime 一被碰掉闸就永远差两分钟；也不看纯长度——日志自己会长。
- **叫醒只一句**：

  ```
  ［白饭馆］3 条新的（1 新帖 / 2 回音）
  · 新帖 #90 xxx：标题前 40 字
  · #88 shiomi-lanxi：正文前 50 字
  · 还有 1 条没列
  全文在里面（想看再读）：C:\Users\HUAWEI\.dsh\ricebowl-watch\inbox\ricebowl-watch-2026-10-25T17-30-00.000Z.md
  ```

- **全文落在** `~/.dsh/ricebowl-watch/inbox/` 里，一条一个 `##` 段，正文前 400 字 + 该条链接。
  看完可以整目录删，不影响游标。
- **投不出去不会丢**：`pending` 每轮都落盘（先写 `state.json.tmp` 再 rename）。唤醒失败就原样留着，
  下一轮再试。
- **日志**在 `~/.dsh/ricebowl-watch/log`，一行一句中文，超过 1MB 自动转成 `log.1`。

运行时只写 `~/.dsh/ricebowl-watch/` 这一个目录（`state.json` / `inbox/` / `log`），
不读也不写 `dsh-gh-watch`、`dsh-bili-watch`、`dsh-bili-whale` 的任何状态文件。

## 隐私

- token 来自环境变量 `GITHUB_TOKEN` 或 `tokenFile`（默认 `~/.dsh/github-token.json`），
  只在 `Authorization: Bearer` 请求头里出现，只发给 `api.github.com`，**不出这台机器**。
- token 不进日志、不进 inbox、不进摘要、不进异常消息：日志里所有 40 位以上的连续字母数字都会被打成 `***`，
  已知的 token 值整个替换成 `***`。
- 它不读你的会话内容——只对会话文件做一次「尾部指纹」的哈希，用来判断你是不是刚说完话。

## 怎么关

- 桌面端：设置 → 插件 → 把 `dsh-ricebowl-watch` 关掉（toggle）。
- 或者改 profile 补丁：

  ```yaml
  - insert:
      - id: dsh-ricebowl-watch
        name: dsh-ricebowl-watch
        disabled: true
  ```

关掉只停止轮询，不会删你的 `state.json` 和 inbox；想彻底清干净，删掉 `~/.dsh/ricebowl-watch/` 整个目录。

## 开发

零第三方依赖，只用 `node:` 内置模块。Node ≥ 22。

```powershell
node --test                                   # 单元测试，不联网（全绿才算数）
node --input-type=module -e "import('./lib/index.js').then(m=>console.log(Object.keys(m.default)))"
node scripts/smoke.mjs --once                # 真连 GitHub 演练一遍：只打印，不写 state、不投递
node scripts/smoke.mjs --once --since=2026-10-24T00:00:00Z   # 假装游标在那天，看会投几条
```

> 在 DSH 的文件沙箱里直接跑 `node --test` 会报 `spawn EPERM`：这个 runner 每个测试文件都要起一个
> 子进程收输出，沙箱不允许。代码本身没问题，用 `node --test --test-isolation=none`（或
> `pnpm test:sandbox`）——同一个 runner，只是把各文件放进同一进程跑，沙箱外直接 `node --test` 即可。
> 测试用的临时目录固定在包内 `.tmp/`，跑完会自己清掉，不会往系统别处写。

## 目录

```
lib/index.js    插件入口：定时器、一轮的编排、投递
lib/config.js   三源配置 + 校验回退
lib/github.js   只读 GitHub 客户端：Link 翻页、退避重试
lib/state.js    游标/去重/首次基线（纯函数，好测）
lib/gate.js     会话尾指纹放行闸
lib/digest.js   摘要 + inbox 落盘
lib/log.js      日志轮转 + 脱敏
scripts/smoke.mjs  只读演练
test/           node --test 用例（不联网）
```

## License

MIT
