#!/usr/bin/env node
// 用 GitHub API 把当前目录推上去（这台机器直连 github.com:443 的 git 协议不通，
// api.github.com 是通的，所以走 git data API：blob → tree → commit → ref）。
//
//   node tools/push.mjs "提交说明"
//
// token：环境变量 GH_TOKEN，或 %USERPROFILE%\.bili-ai\github.json。
// 优先用 `benzi-game token`（细粒度，带 Workflows 写权限），没有再退回 `token`。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const owner = "leno-whale";
// 2026-10-25 修：这个文件是从本子游戏那边拷来的，默认值还写着 benzi，
// 结果第一次推就把接口的文件推进了游戏仓库（d62f913，已回退到 38b91b7）。
// 现在**没有默认值**：要么当前目录有 `.repo` 文件写着仓库名，要么给 GH_REPO。
// 推错仓库的代价是别人的仓库被整棵覆盖，所以宁可推开之前先拒绝。
function targetRepo() {
  if (process.env.GH_REPO) return process.env.GH_REPO.trim();
  const f = path.join(process.cwd(), ".repo");
  if (fs.existsSync(f)) {
    const v = fs.readFileSync(f, "utf8").trim();
    if (v) return v;
  }
  console.error("✗ 不知道该推到哪个仓库。当前目录放一个 .repo 文件（内容是仓库名，例如 talk），或给 GH_REPO。");
  console.error("  加这条检查的原因：2026-10-25 我把接口的文件推成了本子游戏，整棵覆盖。");
  process.exit(2);
}
const repo = targetRepo();
const branch = "main";

// 2026-10-25 修：细粒度 token 是**按仓库授权**的（只覆盖 benzi），
// 拿它去推 talk 会 403「Resource not accessible by personal access token」。
// 所以两把都带上，按顺序试：细粒度优先（它带 workflows 权限），不行再用 classic。
function tokens() {
  if (process.env.GH_TOKEN) return [process.env.GH_TOKEN.trim()];
  const p = path.join(os.homedir(), ".bili-ai", "github.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  const list = [j["benzi-game token"] || j["game token"], j.token].filter(Boolean).map((t) => String(t).trim());
  if (!list.length) { console.error("✗ github.json 里没有 token"); process.exit(2) }
  return list;
}
const TOKENS = tokens();
let tokenIdx = 0;

const H = (i = tokenIdx) => ({
  authorization: `Bearer ${TOKENS[i]}`,
  accept: "application/vnd.github+json",
  "user-agent": "leno-whale",
  "content-type": "application/json",
});

const api = `https://api.github.com/repos/${owner}/${repo}`;

async function call(method, url, body) {
  for (let i = tokenIdx; i < TOKENS.length; i++) {
    const r = await fetch(url, { method, headers: H(i), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { tokenIdx = i; return j }
    // 401/403 = 这把钥匙对这个仓库没权限，换下一把；其余错误直接抛
    if ((r.status === 401 || r.status === 403) && i + 1 < TOKENS.length) {
      console.log(`  （token #${i + 1} 对这个仓库没权限，换第 ${i + 2} 把）`)
      continue;
    }
    throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  }
}

const SKIP = new Set([".git", "__pycache__", "node_modules", ".venv", "_tmp"]);
const SKIP_EXT = new Set([".pyc", ".pyo"]);

function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, rel));
    else if (!SKIP_EXT.has(path.extname(e.name))) out.push({ rel, full });
  }
  return out;
}

async function makeBlobs(list) {
  const blobs = [];
  for (const f of list) {
    const content = fs.readFileSync(f.full).toString("base64");
    const b = await call("POST", `${api}/git/blobs`, { content, encoding: "base64" });
    blobs.push({ path: f.rel, mode: "100644", type: "blob", sha: b.sha });
  }
  return blobs;
}

const files = walk(process.cwd());
const msg = process.argv[2] || "update";

let used = files;
let tree;
try {
  tree = await call("POST", `${api}/git/trees`, { tree: await makeBlobs(files) });
} catch (e) {
  // 旧 token 没有 workflow 权限时，带 .github/workflows 的树会被整棵拒掉。
  const keep = files.filter((f) => !f.rel.startsWith(".github/workflows/"));
  if (keep.length === files.length) throw e;
  console.log(`⚠ 这次用的 token 不接受工作流文件，跳过 .github/workflows/ 重试（${e.message.slice(0, 70)}…）`);
  used = keep;
  tree = await call("POST", `${api}/git/trees`, { tree: await makeBlobs(keep) });
}

let parents = [];
try {
  const ref = await call("GET", `${api}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
} catch {
  /* 第一次推，没有父提交 */
}

const commit = await call("POST", `${api}/git/commits`, { message: msg, tree: tree.sha, parents });

if (parents.length) {
  await call("PATCH", `${api}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
} else {
  await call("POST", `${api}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
}

const wf = used.filter((f) => f.rel.startsWith(".github/workflows/")).length;
console.log(`✓ ${used.length} 个文件（其中工作流 ${wf} 个）→ ${owner}/${repo}@${branch}  ${commit.sha.slice(0, 7)}  ${msg}`);
console.log(`  https://github.com/${owner}/${repo}/commit/${commit.sha}`);

