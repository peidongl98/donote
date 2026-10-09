#!/usr/bin/env node
/**
 * 通过 GitHub Git Data API 把本地 HEAD 的内容推送到远端仓库。
 *
 * 为什么不用 git push：
 *   本机对 github.com:443 的直连被阻断（Git Credential Manager 会弹出账号选择框并挂住），
 *   但 api.github.com 可达。因此改用 REST API 逐文件建 blob → tree → commit → ref。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/push-to-github.cjs [--owner peidongl98] [--repo noteapp] [--branch main]
 *   本机 spawn git 会 EBUSY，请先生成清单：
 *   git -c core.quotepath=false ls-files --cached -z > "$TMPF" && PUSH_FILE_LIST="$TMPF" node scripts/push-to-github.cjs
 *
 * 注意：
 *   - 推送内容 = `git ls-files` 的**完整镜像**（含 base_tree，不会误删远端已有文件）。
 *   - 远端分支已存在时用 PATCH 更新（POST /git/refs 对已存在分支报 422）。
 *   - 验证请用 API（GET /repos/{o}/{r}/git/ref/heads/main），**不要用 `git ls-remote`** ——
 *     会触发本机凭据弹窗并长时间挂起。
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.env.GITHUB_TOKEN || '';
const OWNER = arg('owner', 'peidongl98');
const REPO = arg('repo', 'noteapp');
const BRANCH = arg('branch', 'main');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const API = 'https://api.github.com';

async function gh(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'token ' + TOKEN,
      'User-Agent': 'szjz-migrate',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    throw new Error(method + ' ' + url + ' -> HTTP ' + res.status + ' :: ' + text.slice(0, 300));
  }
  return json;
}

function listFiles() {
  // ⚠️ 本沙箱下 Node spawn git 会报 EBUSY，因此优先读 bash 预先写好的 NUL 分隔清单：
  //    git ls-files --cached -z > <file>
  if (process.env.PUSH_FILE_LIST) {
    return fs
      .readFileSync(process.env.PUSH_FILE_LIST)
      .toString('utf-8')
      .split('\0')
      .filter(Boolean);
  }
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', 'ls-files', '--cached', '-z'],
      { cwd: ROOT }
    ).toString('utf-8');
    return out.split('\0').filter(Boolean);
  } catch (e) {
    throw new Error(
      'git spawn 失败（' + e.code + '）。请先在 bash 里生成清单再跑：\n' +
      '  git -c core.quotepath=false ls-files --cached -z > "$TMPF" && PUSH_FILE_LIST="$TMPF" node scripts/push-to-github.cjs'
    );
  }
}

function headMessage() {
  if (process.env.PUSH_COMMIT_MSG) return process.env.PUSH_COMMIT_MSG;
  if (process.env.PUSH_COMMIT_MSG_FILE) {
    return fs.readFileSync(process.env.PUSH_COMMIT_MSG_FILE).toString('utf-8').trim();
  }
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT })
      .toString('utf-8')
      .trim();
  } catch (e) {
    return '';
  }
}

async function pool(items, limit, worker) {
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function main() {
  if (!TOKEN) {
    console.error('缺少 GITHUB_TOKEN 环境变量');
    process.exit(1);
  }
  const files = listFiles().filter((rel) => {
    try { return fs.statSync(path.join(ROOT, rel)).isFile(); } catch (e) { return false; }
  });
  console.log('待推送文件数:', files.length);

  // 1) blobs
  const tree = new Array(files.length);
  let done = 0;
  await pool(files, 6, async (rel, idx) => {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const r = await gh('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    tree[idx] = { path: rel, mode: '100644', type: 'blob', sha: r.sha };
    done += 1;
    if (done % 20 === 0) console.log('  blobs %d/%d', done, files.length);
  });
  console.log('  blobs 完成:', tree.length);

  // 2) 取当前远端 head（空仓库时为 null）
  let parents = [];
  let parentSha = null;
  let branchExists = false;
  try {
    const head = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    if (head && head.object && head.object.sha) {
      parentSha = head.object.sha;
      parents = [parentSha];
      branchExists = true;
    }
  } catch (e) {
    /* 空仓库：无 parent */
  }
  console.log('parents =', parents);

  // 3) tree：带 base_tree，避免「完整镜像」之外的既有文件被误删
  const treeBody = { tree };
  if (parentSha) {
    const parentCommit = await gh('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
    if (parentCommit && parentCommit.tree && parentCommit.tree.sha) {
      treeBody.base_tree = parentCommit.tree.sha;
      // 远端存在、本地已删除的文件：显式置 sha=null 删除，否则 base_tree 会一直保留
      const pt = await gh('GET', `/repos/${OWNER}/${REPO}/git/trees/${parentCommit.tree.sha}?recursive=1`);
      const localSet = new Set(files);
      const delEntries = (pt.tree || [])
        .filter((e) => e.type === 'blob' && !localSet.has(e.path))
        .map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: null }));
      if (delEntries.length) {
        console.log('  同步删除远端已删文件:', delEntries.map((e) => e.path).join(', '));
        treeBody.tree = tree.concat(delEntries);
      }
    }
  }
  const treeRes = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, treeBody);
  console.log('tree sha =', treeRes.sha);

  // 3b) 自检：tree 文件数必须 >= 本次推送文件数，少一个就中止
  const treeCheck = await gh('GET', `/repos/${OWNER}/${REPO}/git/trees/${treeRes.sha}?recursive=1`);
  const treeCount = (treeCheck.tree || []).filter((e) => e.type === 'blob').length;
  console.log('tree 内文件数 =', treeCount, '（期望 =', files.length, '）');
  if (treeCount !== files.length) {
    throw new Error('tree 文件数与预期不符，已中止（防止远端被清空）');
  }

  // 4) commit
  const msg = headMessage() || 'chore: 迁移前快照';
  const commit = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg + '\n\n（由 scripts/push-to-github.cjs 通过 Git Data API 推送）',
    tree: treeRes.sha,
    parents: parents,
  });
  console.log('commit sha =', commit.sha);

  // 5) 更新 ref：分支已存在用 PATCH（POST 会报 422 Reference already exists）
  if (branchExists) {
    const ref = await gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.sha,
      force: false,
    });
    console.log('ref =', ref.ref, '->', ref.object && ref.object.sha);
  } else {
    const ref = await gh('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: 'refs/heads/' + BRANCH,
      sha: commit.sha,
    });
    console.log('ref =', ref.ref, '->', ref.object && ref.object.sha);
  }

  // 6) 核验（用 API，别用 git ls-remote）
  const verify = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const remoteSha = verify && verify.object && verify.object.sha;
  console.log('远端 ' + BRANCH + ' =', remoteSha, remoteSha === commit.sha ? 'OK' : '不一致！');
  console.log('完成：https://github.com/' + OWNER + '/' + REPO);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
