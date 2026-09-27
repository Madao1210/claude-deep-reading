#!/usr/bin/env node
// checkpoint.mjs —— 检查点写入（临时文件 → 原子提交）与复用判定
//   write  --kind memory|user-note|user-state|reader|export
//          memory 需要 --chapter 与 --state(complete|partial)，payload 必须含 [n] 段落定位
//   status 逐章输出 reusable 判定（哈希 + 方法版本 + 完整状态）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const TOOL_NAME = 'deep-reading-checkpoint'
const TOOL_VERSION = '0.1.1'
// 阅读方法/记忆协议版本：记忆格式或判定规则变化时递增（旧记忆将视为过期）
const METHOD_VERSION = '1.0'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOKS_DIR = path.join(ROOT, 'books')

function out(obj) {
  console.log(JSON.stringify(obj, null, 2))
}

function fail(error, hint) {
  out({ ok: false, error, ...(hint ? { hint } : {}) })
  process.exit(1)
}

function parseArgs(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--stdin') { o.stdin = true; continue }
    if (!a.startsWith('--')) { o._.push(a); continue }
    const name = a.slice(2)
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) fail(`参数 --${name} 缺少取值`)
    o[name] = val
    i++
  }
  return o
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => sha256(fs.readFileSync(p))
const rand6 = () => crypto.randomBytes(3).toString('hex')
const pad3 = (n) => String(n).padStart(3, '0')

function loadBook(id) {
  if (!id) fail('缺少 --book（书籍 ID）')
  const dir = path.join(BOOKS_DIR, id)
  const bookJsonPath = path.join(dir, 'book.json')
  if (!fs.existsSync(bookJsonPath)) fail(`书籍不存在：books/${id}（先用 split.mjs 导入）`)
  return { dir, book: JSON.parse(fs.readFileSync(bookJsonPath, 'utf8')) }
}

function atomicWrite(target, content) {
  const tmp = `${target}.tmp-${rand6()}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

function serializeFrontmatter(obj) {
  const lines = ['---']
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    lines.push(`${k}: ${typeof v === 'number' ? v : JSON.stringify(String(v))}`)
  }
  lines.push('---')
  return lines.join('\n')
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 3)
  if (end === -1) return null
  const fm = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!m) continue
    const raw = m[2].trim()
    if (raw === '') { fm[m[1]] = ''; continue }
    try { fm[m[1]] = JSON.parse(raw) } catch { fm[m[1]] = raw }
  }
  return fm
}

function readPayload(args) {
  if (args.file !== undefined && args.stdin) fail('--file 与 --stdin 只能用一个')
  let content
  if (args.stdin) {
    content = fs.readFileSync(0, 'utf8')
  } else if (args.file !== undefined) {
    const p = path.resolve(args.file)
    if (!fs.existsSync(p)) fail(`payload 文件不存在：${p}`)
    content = fs.readFileSync(p, 'utf8')
  } else {
    fail('缺少 payload：用 --file <payload.md> 或 --stdin')
  }
  content = content.replace(/\r\n/g, '\n')
  if (!content.trim()) fail('payload 为空')
  if (content.startsWith('---\n') || content.trim() === '---') {
    fail('payload 不应自带 frontmatter（--- 开头），frontmatter 由本工具注入')
  }
  return content
}

function parseCovered(s, paras) {
  const m = String(s).match(/^(\d+)-(\d+)\/(\d+)$/)
  if (!m) fail(`--covered 格式应为 "a-b/total"（如 1-3/7），收到：${s}`)
  const a = Number(m[1])
  const b = Number(m[2])
  const total = Number(m[3])
  if (total !== paras) fail(`--covered 的总数与章节段数不符：covered=${total}，本章共 ${paras} 段`)
  if (a !== 1) fail(`分节覆盖应从第 1 段开始：--covered 应以 "1-" 开头`)
  if (a > b || b > total) fail(`--covered 区间不合法：${s}`)
  return { a, b, total }
}

// ---------- write ----------

function doWrite(args) {
  const { dir, book } = loadBook(args.book)
  const kind = args.kind
  if (!kind) fail('缺少 --kind（memory|lecture|user-note|user-state|reader|export）')

  // 导出：manifest 拼接（不调用模型、不改写内容）
  if (kind === 'export') {
    if (args.chapter !== undefined) fail('export 不支持 --chapter（导出是 manifest 拼接）')
    if (!args.name) fail('export 需要 --name（如 reading.md）')
    if (!/^[A-Za-z0-9._-]{1,80}\.md$/.test(args.name)) fail(`--name 不合法：${args.name}（只允许字母数字._-，以 .md 结尾）`)
    const manifest = readPayload(args)
    const included = []
    const parts = []
    for (const line of manifest.split('\n')) {
      const m = line.match(/^@include\s+(.+?)\s*$/)
      if (!m) { parts.push(line); continue }
      const rel = m[1].replace(/\\/g, '/')
      const abs = path.resolve(dir, rel)
      if (!abs.startsWith(dir + path.sep)) fail(`@include 越出书籍目录：${rel}`)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`@include 的文件不存在：${rel}`)
      let content = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
      if (!content.endsWith('\n')) content += '\n'
      parts.push(content)
      included.push(rel)
    }
    const text = parts.join('\n')
    const target = path.join(dir, 'exports', args.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const replaced = fs.existsSync(target)
    atomicWrite(target, text)
    out({
      ok: true, kind: 'export', path: `exports/${args.name}`, absPath: target,
      bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(Buffer.from(text, 'utf8')),
      included, replaced,
    })
    return
  }

  const payload = readPayload(args)
  const now = new Date().toISOString()

  // 各 kind 的目标与 frontmatter
  let target
  let fm
  if (kind === 'memory') {
    if (args.chapter === undefined) fail('memory 需要 --chapter')
    const n = Number(args.chapter)
    const ch = (book.chapters || []).find((c) => c.n === n)
    if (!ch) fail(`章节不存在：第 ${n} 章`)
    const chFile = path.join(dir, ch.file)
    if (!fs.existsSync(chFile)) fail(`章节文件缺失：${ch.file}`)
    const sourceSha = sha256File(chFile)
    // 仍有效的 complete 记忆不允许改写（跨章理解变化写进新章记忆）
    const existMemPath = path.join(dir, 'memory', `${pad3(n)}.md`)
    if (fs.existsSync(existMemPath)) {
      const existFm = parseFrontmatter(fs.readFileSync(existMemPath, 'utf8'))
      if (existFm && existFm.state === 'complete' && existFm.source_sha256 === sourceSha && existFm.method_version === METHOD_VERSION) {
        fail(`第 ${n} 章记忆已是 complete 且仍然有效，不允许改写`, '跨章理解变化时：在后续章节的记忆中写"修正了第 N 章的 X 结论"并引用定位，不要回改旧文件')
      }
    }
    const state = args.state === undefined ? 'complete' : args.state
    if (state !== 'complete' && state !== 'partial') fail(`--state 只能是 complete 或 partial`)
    if (!/\[\d+[-\d]*\]/.test(payload)) {
      fail('记忆必须包含段落定位（如 [12]）；缺定位时先补定位，不要压缩内容')
    }
    let covered
    if (state === 'partial') {
      if (args.covered === undefined) fail('state=partial 时必须给 --covered "a-b/total"')
      const c = parseCovered(args.covered, ch.paras)
      if (c.b >= ch.paras) fail(`covered=${c.b}/${ch.paras} 已覆盖全部段落，请改用 --state complete`)
      // 已有 partial 时必须推进（状态链连续）
      const oldPath = path.join(dir, 'memory', `${pad3(n)}.md`)
      if (fs.existsSync(oldPath)) {
        const oldFm = parseFrontmatter(fs.readFileSync(oldPath, 'utf8'))
        if (oldFm && oldFm.state === 'partial' && oldFm.covered) {
          const oc = String(oldFm.covered).match(/^(\d+)-(\d+)\/(\d+)$/)
          if (oc && Number(oc[2]) >= c.b) fail(`covered 未推进：已有 ${oldFm.covered}，新值 ${args.covered}`)
        }
      }
      covered = `${c.a}-${c.b}/${c.total}`
    } else {
      covered = `1-${ch.paras}/${ch.paras}`
    }
    target = path.join(dir, 'memory', `${pad3(n)}.md`)
    fm = {
      book: book.id, kind, chapter: n, state, covered,
      source_sha256: sourceSha,
      method_version: METHOD_VERSION, tool_version: TOOL_VERSION,
      written_at: now, note: args.note,
    }
  } else if (kind === 'lecture') {
    if (args.chapter === undefined) fail('lecture 需要 --chapter')
    const n = Number(args.chapter)
    const ch = (book.chapters || []).find((c) => c.n === n)
    if (!ch) fail(`章节不存在：第 ${n} 章`)
    target = path.join(dir, 'lecture', `${pad3(n)}.md`)
    fm = {
      book: book.id, kind, chapter: n, state: 'complete',
      source_sha256: sha256File(path.join(dir, ch.file)),
      method_version: METHOD_VERSION, tool_version: TOOL_VERSION,
      written_at: now, note: args.note,
    }
  } else if (kind === 'user-note') {
    if (args.chapter === undefined) fail('user-note 需要 --chapter')
    const n = Number(args.chapter)
    const ch = (book.chapters || []).find((c) => c.n === n)
    if (!ch) fail(`章节不存在：第 ${n} 章`)
    target = path.join(dir, 'user', `${pad3(n)}.md`)
    fm = {
      book: book.id, kind, chapter: n, state: 'complete',
      source_sha256: sha256File(path.join(dir, ch.file)),
      method_version: METHOD_VERSION, tool_version: TOOL_VERSION,
      written_at: now, note: args.note,
    }
  } else if (kind === 'user-state') {
    target = path.join(dir, 'user', 'state.md')
    fm = {
      book: book.id, kind, state: 'complete', written_at: now,
      method_version: METHOD_VERSION, tool_version: TOOL_VERSION, note: args.note,
    }
  } else if (kind === 'reader') {
    target = path.join(dir, 'reader.md')
    fm = {
      book: book.id, kind, state: 'complete', written_at: now,
      method_version: METHOD_VERSION, tool_version: TOOL_VERSION, note: args.note,
    }
  } else {
    fail(`未知的 --kind：${kind}（memory|lecture|user-note|user-state|reader|export）`)
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  const replaced = fs.existsSync(target)
  const text = `${serializeFrontmatter(fm)}\n\n${payload.trimEnd()}\n`
  atomicWrite(target, text)

  // memory 写入后更新 book.json 镜像（status 以文件为准，这里只是目录视图）
  if (kind === 'memory') {
    const n = Number(args.chapter)
    const ch = (book.chapters || []).find((c) => c.n === n)
    ch.state = fm.state === 'complete' ? 'analyzed' : 'unanalyzed'
    ch.memory = {
      file: `memory/${pad3(n)}.md`, state: fm.state, covered: fm.covered,
      sourceSha256: fm.source_sha256, methodVersion: fm.method_version,
      toolVersion: fm.tool_version, writtenAt: fm.written_at,
    }
    atomicWrite(path.join(dir, 'book.json'), JSON.stringify(book, null, 2) + '\n')
  }

  out({
    ok: true, kind, path: path.relative(dir, target).replace(/\\/g, '/'), absPath: target,
    bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(Buffer.from(text, 'utf8')),
    state: fm.state, covered: fm.covered || null, replaced,
    frontmatter: fm,
  })
}

// ---------- status ----------

function doStatus(args) {
  const { dir, book } = loadBook(args.book)
  let targets = book.chapters || []
  if (args.chapter !== undefined) {
    const n = Number(args.chapter)
    targets = targets.filter((c) => c.n === n)
    if (targets.length === 0) fail(`章节不存在：第 ${n} 章`)
  }
  const chapters = targets.map((ch) => {
    const memRel = `memory/${pad3(ch.n)}.md`
    const memAbs = path.join(dir, memRel)
    const sourceAbs = path.join(dir, ch.file)
    const sourceSha = fs.existsSync(sourceAbs) ? sha256File(sourceAbs) : null
    if (!fs.existsSync(memAbs)) {
      return {
        n: ch.n, title: ch.title, hasMemory: false, state: null, covered: null,
        sourceSha256Match: null, methodVersionMatch: null,
        reusable: false, reason: 'no-memory', memoryFile: null, writtenAt: null,
      }
    }
    const fm = parseFrontmatter(fs.readFileSync(memAbs, 'utf8'))
    if (!fm) {
      return {
        n: ch.n, title: ch.title, hasMemory: true, state: null, covered: null,
        sourceSha256Match: null, methodVersionMatch: null,
        reusable: false, reason: 'no-frontmatter', memoryFile: memRel, writtenAt: null,
      }
    }
    const sourceSha256Match = sourceSha !== null && fm.source_sha256 === sourceSha
    const methodVersionMatch = fm.method_version === METHOD_VERSION
    let reason = 'ok'
    if (fm.state !== 'complete') reason = `state-${fm.state}`
    else if (!sourceSha256Match) reason = 'hash-mismatch'
    else if (!methodVersionMatch) reason = 'method-mismatch'
    const reusable = reason === 'ok'
    return {
      n: ch.n, title: ch.title, hasMemory: true, state: fm.state, covered: fm.covered || null,
      sourceSha256Match, methodVersionMatch, reusable, reason,
      memoryFile: memRel, writtenAt: fm.written_at || null,
    }
  })
  out({
    ok: true, book: book.id, methodVersion: METHOD_VERSION, chapters,
    summary: {
      total: chapters.length,
      reusable: chapters.filter((c) => c.reusable).length,
      partial: chapters.filter((c) => c.reason === 'state-partial').length,
      stale: chapters.filter((c) => c.reason === 'hash-mismatch' || c.reason === 'method-mismatch').length,
      unread: chapters.filter((c) => c.reason === 'no-memory').length,
    },
  })
}

// ---------- main ----------

try {
  const argv = process.argv.slice(2)
  const sub = argv[0]
  const args = parseArgs(argv.slice(1))
  if (sub === 'write') doWrite(args)
  else if (sub === 'status') doStatus(args)
  else fail(`未知子命令：${sub || '(空)'}（write | status）`)
} catch (e) {
  fail(`检查点操作失败：${e && e.message ? e.message : String(e)}`)
}
