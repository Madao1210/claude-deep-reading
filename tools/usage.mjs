#!/usr/bin/env node
// usage.mjs —— 从当前会话 JSONL 游标式提取 Token 用量，追加到 books/<ID>/usage.jsonl
// 说明：主会话用量取自 assistant 条目的 message.usage；
//       子任务（fork/子代理）只有聚合总数（subagent_tokens），没有输入/输出拆分，如实标注。
//       子任务总数只在 queue-operation/enqueue 的任务完成通知里认一次：
//       同一份通知会在转录里重复出现（attachment、助手引用等），且同一 task-id 可能通知多次，
//       因此按 task-id 去重（多次通知视为累计总量，取增量），去重表随游标持久化。
//       fork 子任务不产生完成通知 → 从会话目录 subagents/agent-*.jsonl 转录直接计入，
//       按文件 size 做增量去重；登记表为全局 books/.usage-agents.json，与完成通知按 id 互斥（先到先计）。
//       --agent <id>：本次只计这一个子代理转录（补账/核对用）；--agent none 跳过子代理扫描（只记主会话窗口）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOKS_DIR = path.join(ROOT, 'books')
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

function out(obj) {
  console.log(JSON.stringify(obj, null, 2))
}

function fail(error, hint) {
  out({ ok: false, error, ...(hint ? { hint } : {}) })
  process.exit(1)
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--latest') { o.latest = true; continue }
    if (a === '--report') { o.report = true; continue }
    if (!a.startsWith('--')) fail(`无法识别的参数：${a}`)
    const name = a.slice(2)
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) fail(`参数 --${name} 缺少取值`)
    o[name] = val
    i++
  }
  return o
}

const rand6 = () => crypto.randomBytes(3).toString('hex')

function atomicWrite(target, content) {
  const tmp = `${target}.tmp-${rand6()}`
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

// 在所有项目目录里找 <sessionId>.jsonl；--latest 取最新修改的那个
function findTranscript(sessionId, latest) {
  if (!fs.existsSync(PROJECTS_DIR)) fail(`找不到会话目录：${PROJECTS_DIR}`)
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
  let newest = null
  for (const d of dirs) {
    const dirPath = path.join(PROJECTS_DIR, d.name)
    let files
    try { files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const p = path.join(dirPath, f)
      if (latest) {
        const st = fs.statSync(p)
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { p, mtimeMs: st.mtimeMs }
      } else if (f === `${sessionId}.jsonl`) {
        return p
      }
    }
  }
  return latest ? (newest ? newest.p : null) : null
}

// ---------- report ----------

function doReport(id) {
  const bookDir = path.join(BOOKS_DIR, id)
  const bookJsonPath = path.join(bookDir, 'book.json')
  if (!fs.existsSync(bookJsonPath)) fail(`书籍不存在：books/${id}`)
  const book = JSON.parse(fs.readFileSync(bookJsonPath, 'utf8'))
  const total = (book.chapters || []).length

  const rows = []
  const usagePath = path.join(bookDir, 'usage.jsonl')
  if (fs.existsSync(usagePath)) {
    for (const line of fs.readFileSync(usagePath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
  }

  const zeroMain = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 })
  const chapters = Array.from({ length: total }, (_, i) => ({
    chapter: i + 1, main: zeroMain(), subagentTokens: 0, baselineTokens: 0, tasks: [],
  }))
  const other = []

  for (const r of rows) {
    const task = String(r.task || '')
    const m = task.match(/ch(?:apter)?[\s-]*0*(\d+)/i)
    const idx = m ? Number(m[1]) - 1 : -1
    const cw = (r.cacheWrite5m || 0) + (r.cacheWrite1h || 0)
    if (idx >= 0 && idx < total) {
      const row = chapters[idx]
      row.tasks.push(task)
      if (/baseline/i.test(task)) {
        row.baselineTokens += r.subagentTokens || 0
      } else {
        row.main.requests += r.requests || 0
        row.main.input += r.input || 0
        row.main.output += r.output || 0
        row.main.cacheRead += r.cacheRead || 0
        row.main.cacheWrite += cw
        row.main.thinking += r.thinking || 0
        row.subagentTokens += r.subagentTokens || 0
      }
    } else {
      other.push({
        ts: r.ts || null, task, requests: r.requests || 0, input: r.input || 0,
        output: r.output || 0, cacheRead: r.cacheRead || 0, cacheWrite: cw, subagentTokens: r.subagentTokens || 0,
      })
    }
  }

  const totals = { main: zeroMain(), subagentTokens: 0, baselineTokens: 0 }
  for (const row of chapters) {
    row.main.total = row.main.input + row.main.output + row.main.cacheRead + row.main.cacheWrite + row.main.thinking
    totals.main.requests += row.main.requests
    totals.main.input += row.main.input
    totals.main.output += row.main.output
    totals.main.cacheRead += row.main.cacheRead
    totals.main.cacheWrite += row.main.cacheWrite
    totals.main.thinking += row.main.thinking
    totals.subagentTokens += row.subagentTokens
    totals.baselineTokens += row.baselineTokens
  }
  totals.main.total = totals.main.input + totals.main.output + totals.main.cacheRead + totals.main.cacheWrite + totals.main.thinking

  out({
    ok: true, mode: 'report', book: id, title: book.title || null, chapterCount: total,
    note: '主会话=按章相关行的窗口值累加（含窗口内其他活动）；子代理仅总数；基线列可空',
    chapters, totals, other,
  })
}

// 汇总单个子代理转录（subagents/agent-*.jsonl）里 assistant 条目的用量
function sumAgentUsage(p) {
  const t = { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, total: 0 }
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const u = o && o.message && o.message.usage
    if (o && o.type === 'assistant' && u) {
      t.requests += 1
      t.input += u.input_tokens || 0
      const cc = u.cache_creation
      const hasBreakdown = cc && ('ephemeral_5m_input_tokens' in cc || 'ephemeral_1h_input_tokens' in cc)
      t.cacheWrite += hasBreakdown
        ? (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0)
        : u.cache_creation_input_tokens || 0
      t.cacheRead += u.cache_read_input_tokens || 0
      t.output += u.output_tokens || 0
      t.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0
    }
  }
  t.total = t.input + t.cacheWrite + t.cacheRead + t.output + t.thinking
  return t
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const id = args.book
  if (!id) fail('缺少 --book（书籍 ID）')
  if (!args.task && !args.report) fail('缺少 --task（本次记账的标签，如 "read-ch1" / "split" / "export"）')
  if (args.report) {
    doReport(id)
    return
  }

  const bookDir = path.join(BOOKS_DIR, id)
  if (!fs.existsSync(path.join(bookDir, 'book.json'))) fail(`书籍不存在：books/${id}`)

  const sessionId = args.session || process.env.CLAUDE_CODE_SESSION_ID
  if (!args.latest && !sessionId) {
    fail('无法确定会话：环境变量 CLAUDE_CODE_SESSION_ID 不存在，也没有传 --session', '在 Claude Code 的 Bash 里运行可自动获取；否则用 --session <id> 或 --latest')
  }

  const transcript = findTranscript(sessionId, args.latest)
  if (!transcript) {
    fail(args.latest ? '找不到任何会话 JSONL' : `找不到会话文件 ${sessionId}.jsonl（在 ${PROJECTS_DIR} 下搜索）`)
  }

  const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.trim() !== '')

  const cursorPath = path.join(bookDir, '.usage-cursor.json')
  let cursor = {}
  if (fs.existsSync(cursorPath)) {
    try { cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) } catch { cursor = {} }
  }
  const key = path.basename(transcript, '.jsonl')
  let start = cursor[key] && Number.isInteger(cursor[key].lines) ? cursor[key].lines : 0
  let resynced = false
  if (start > lines.length) { start = 0; resynced = true }
  const subagentTasks = (cursor[key] && cursor[key].subagentTasks) || {}

  // 子代理转录的全局登记表（books/.usage-agents.json）：id → {size, via, ...}
  const agentsRegPath = path.join(BOOKS_DIR, '.usage-agents.json')
  let agentsReg = {}
  if (fs.existsSync(agentsRegPath)) {
    try { agentsReg = JSON.parse(fs.readFileSync(agentsRegPath, 'utf8')) } catch { agentsReg = {} }
  }

  const added = {
    requests: 0, input: 0, output: 0, cacheRead: 0,
    cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, subagentTokens: 0,
  }
  const models = new Set()

  for (const line of lines.slice(start)) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    const u = o && o.message && o.message.usage
    if (o && o.type === 'assistant' && u) {
      added.requests += 1
      added.input += u.input_tokens || 0
      added.output += u.output_tokens || 0
      added.cacheRead += u.cache_read_input_tokens || 0
      const cc = u.cache_creation
      const hasBreakdown = cc && ('ephemeral_5m_input_tokens' in cc || 'ephemeral_1h_input_tokens' in cc)
      if (hasBreakdown) {
        added.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0
        added.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0
      } else {
        added.cacheWrite5m += u.cache_creation_input_tokens || 0
      }
      added.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0
      if (o.message.model) models.add(o.message.model)
    }
    if (o && o.type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string') {
      const tm = o.content.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/)
      if (tm) {
        const total = Number(tm[1])
        const id = (o.content.match(/<task-id>([^<]+)<\/task-id>/) || [])[1]
        if (!id) {
          added.subagentTokens += total
        } else if (!agentsReg[id]) {
          const prev = subagentTasks[id] || 0
          if (total > prev) {
            added.subagentTokens += total - prev
            subagentTasks[id] = total
          }
        }
      }
    }
  }

  // 子代理转录计入：完成通知缺失时（fork 等），从 subagents/agent-*.jsonl 直接取用量
  const subagentsDir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  let agentHit = false
  if (args.agent !== 'none' && fs.existsSync(subagentsDir)) {
    for (const f of fs.readdirSync(subagentsDir)) {
      if (!/^agent-[A-Za-z0-9]+\.jsonl$/.test(f)) continue
      const aid = f.slice('agent-'.length, -'.jsonl'.length)
      if (args.agent && aid !== args.agent) continue
      const p = path.join(subagentsDir, f)
      const st = fs.statSync(p)
      const prev = agentsReg[aid]
      agentHit = true
      // 已由完成通知计过账的：不再从转录计（可能被恢复的任务会再次通知，也走通知增量）
      if (prev && prev.via === 'notification') continue
      if (!args.agent && prev && prev.size === st.size) continue
      const d = sumAgentUsage(p)
      if (!args.agent && !prev && subagentTasks[aid] !== undefined) {
        // 首次遇到且该 id 的通知已入账：只登记基线，不重复计入
        agentsReg[aid] = { size: st.size, tokens: d.total, via: 'notification', requests: d.requests, input: d.input, cacheWrite: d.cacheWrite, cacheRead: d.cacheRead, output: d.output }
        continue
      }
      const delta = d.total - (prev ? prev.tokens : 0)
      if (delta > 0) added.subagentTokens += delta
      agentsReg[aid] = { size: st.size, tokens: d.total, via: 'transcript', requests: d.requests, input: d.input, cacheWrite: d.cacheWrite, cacheRead: d.cacheRead, output: d.output }
    }
  }
  if (args.agent && args.agent !== 'none' && !agentHit) fail(`找不到子代理转录：subagents/agent-${args.agent}.jsonl`)
  atomicWrite(agentsRegPath, JSON.stringify(agentsReg, null, 2) + '\n')

  cursor[key] = { lines: lines.length, updatedAt: new Date().toISOString(), subagentTasks }
  atomicWrite(cursorPath, JSON.stringify(cursor, null, 2) + '\n')

  const window = { from: start, to: lines.length, resynced }
  if (added.requests === 0 && added.subagentTokens === 0) {
    out({ ok: true, appended: false, reason: 'no-new-entries', task: args.task, session: { id: key, path: transcript }, window, file: path.join(bookDir, 'usage.jsonl') })
    return
  }

  const row = {
    ts: new Date().toISOString(),
    task: args.task,
    sessionId: key,
    models: [...models].join(','),
    requests: added.requests,
    input: added.input,
    output: added.output,
    cacheRead: added.cacheRead,
    cacheWrite5m: added.cacheWrite5m,
    cacheWrite1h: added.cacheWrite1h,
    thinking: added.thinking,
    subagentTokens: added.subagentTokens,
    ...(added.subagentTokens > 0 ? { subagentNote: '子代理 token 仅总数，无输入/输出拆分' } : {}),
    window,
  }
  fs.appendFileSync(path.join(bookDir, 'usage.jsonl'), JSON.stringify(row) + '\n', 'utf8')

  out({ ok: true, appended: true, task: args.task, session: { id: key, path: transcript }, window, added, file: path.join(bookDir, 'usage.jsonl') })
}

try {
  main()
} catch (e) {
  fail(`用量记账失败：${e && e.message ? e.message : String(e)}`)
}
