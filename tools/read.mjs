#!/usr/bin/env node
// read.mjs —— 范围读取工具（只读，绝不写盘）
// 模式：--index 目录 | --chapter 范围读取 | --locate 定位 | --find 关键词检索
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOKS_DIR = path.join(ROOT, 'books')
const DEFAULT_MAX_BYTES = 20000
const DEFAULT_CONTEXT = 1
const DEFAULT_LIMIT = 20

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
    if (a === '--index') { o.index = true; continue }
    if (!a.startsWith('--')) fail(`无法识别的参数：${a}`)
    const name = a.slice(2)
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) fail(`参数 --${name} 缺少取值`)
    o[name] = val
    i++
  }
  return o
}

const byteLen = (s) => Buffer.byteLength(s, 'utf8')

function loadBook(id) {
  const dir = path.join(BOOKS_DIR, id)
  const bookJsonPath = path.join(dir, 'book.json')
  if (!fs.existsSync(bookJsonPath)) {
    fail(`书籍不存在：books/${id}（先用 split.mjs 导入）`)
  }
  return { dir, book: JSON.parse(fs.readFileSync(bookJsonPath, 'utf8')) }
}

function chapterMeta(book, n) {
  const ch = (book.chapters || []).find((c) => c.n === n)
  if (!ch) fail(`章节不存在：第 ${n} 章（本书共 ${(book.chapters || []).length} 章）`)
  return ch
}

// 解析 chapters/NNN.md 为 [{n, text}]；要求编号从 1 连续
function parseChapterUnits(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const units = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s?(.*)$/)
    if (m) {
      if (cur) units.push(cur)
      cur = { n: Number(m[1]), lines: [m[2]] }
    } else if (cur && line.trim() !== '') {
      cur.lines.push(line)
    }
  }
  if (cur) units.push(cur)
  const parsed = units.map((u) => ({ n: u.n, text: u.lines.join('\n').trim() }))
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].n !== i + 1) {
      fail(`章节文件损坏：段落编号不连续（第 ${i + 1} 个块是 [${parsed[i].n}]）`)
    }
  }
  return parsed
}

function readUnits(bookDir, n) {
  const file = path.join(bookDir, `chapters/${String(n).padStart(3, '0')}.md`)
  if (!fs.existsSync(file)) fail(`章节文件缺失：${file}`)
  return parseChapterUnits(fs.readFileSync(file, 'utf8'))
}

const renderUnits = (units) => units.map((u) => `[${u.n}] ${u.text}`).join('\n\n')

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.book) fail('缺少 --book（书籍 ID）')

  const modes = ['index', 'locate', 'find'].filter((m) => args[m] !== undefined && args[m] !== false)
  if (modes.length > 1) fail(`模式互斥：一次只能用 ${modes.map((m) => '--' + m).join(' / ')} 中的一个`)

  const { dir, book } = loadBook(args.book)
  const maxBytes = args['max-bytes'] !== undefined ? Number(args['max-bytes']) : DEFAULT_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) fail('--max-bytes 必须是正整数')

  // ---- index 模式 ----
  if (args.index) {
    out({
      ok: true, mode: 'index', dir,
      book: {
        id: book.id, title: book.title, source: book.source,
        importedAt: book.importedAt, chapterCount: (book.chapters || []).length,
      },
      chapters: (book.chapters || []).map((c) => ({
        n: c.n, title: c.title, file: c.file, paras: c.paras, chars: c.chars,
        state: c.state, memory: c.memory || null,
      })),
    })
    return
  }

  // ---- find 模式（全书或指定章扫描） ----
  if (args.find !== undefined) {
    const kw = args.find
    const limit = args.limit !== undefined ? Number(args.limit) : DEFAULT_LIMIT
    if (!Number.isFinite(limit) || limit <= 0) fail('--limit 必须是正整数')
    const targets = args.chapter !== undefined
      ? [chapterMeta(book, Number(args.chapter))]
      : (book.chapters || [])
    const matches = []
    let truncated = false
    outer:
    for (const ch of targets) {
      const units = readUnits(dir, ch.n)
      for (const u of units) {
        const i = u.text.indexOf(kw)
        if (i === -1) continue
        const before = u.text.slice(Math.max(0, i - 24), i)
        const after = u.text.slice(i + kw.length, i + kw.length + 24)
        matches.push({
          chapter: ch.n,
          para: u.n,
          snippet: `${i > 24 ? '…' : ''}${before}${kw}${after}${i + kw.length + 24 < u.text.length ? '…' : ''}`,
        })
        if (matches.length >= limit) { truncated = true; break outer }
      }
    }
    out({
      ok: true, mode: 'find', book: book.id, find: kw,
      scannedChapters: targets.map((c) => c.n),
      matches, hasMore: truncated,
    })
    return
  }

  // ---- 需要 --chapter 的模式 ----
  if (args.chapter === undefined) fail('缺少 --chapter（或使用 --index / --find）')
  const n = Number(args.chapter)
  if (!Number.isInteger(n) || n < 1) fail('--chapter 必须是正整数')
  const ch = chapterMeta(book, n)
  const units = readUnits(dir, n)
  const total = units.length

  // ---- locate 模式 ----
  if (args.locate !== undefined) {
    const phrase = args.locate
    const k = args.context !== undefined ? Number(args.context) : DEFAULT_CONTEXT
    if (!Number.isInteger(k) || k < 0) fail('--context 必须是非负整数')
    const hitNs = units.filter((u) => u.text.includes(phrase)).map((u) => u.n)
    const matches = []
    let bytesAcc = 0
    let truncated = false
    for (let idx = 0; idx < hitNs.length; idx++) {
      const hit = hitNs[idx]
      const from = Math.max(1, hit - k)
      const to = Math.min(total, hit + k)
      const contextText = renderUnits(units.filter((u) => u.n >= from && u.n <= to))
      const addBytes = byteLen(contextText)
      if (bytesAcc + addBytes > maxBytes && matches.length > 0) {
        truncated = true
        break
      }
      bytesAcc += addBytes
      matches.push({ n: hit, text: units[hit - 1].text, from, to, contextText })
    }
    out({
      ok: true, mode: 'locate', book: book.id, chapter: n, phrase,
      totalParas: total, matchCount: hitNs.length, matches,
      hasMore: truncated, bytes: bytesAcc,
    })
    return
  }

  // ---- 范围读取模式 ----
  const from = args.from !== undefined ? Number(args.from) : 1
  const to = args.to !== undefined ? Number(args.to) : total
  if (!Number.isInteger(from) || !Number.isInteger(to)) fail('--from / --to 必须是整数')
  if (from < 1 || to > total || from > to) {
    fail(`范围越界：--from ${from} --to ${to}，本章共 ${total} 段`)
  }
  const picked = []
  let bytesAcc = 0
  let truncatedBy = null
  for (const u of units) {
    if (u.n < from || u.n > to) continue
    const rendered = `[${u.n}] ${u.text}`
    const add = byteLen(rendered)
    if (bytesAcc + add > maxBytes && picked.length > 0) {
      truncatedBy = 'max-bytes'
      break
    }
    picked.push(u)
    bytesAcc += add + 2
  }
  const emittedTo = picked.length > 0 ? picked[picked.length - 1].n : from - 1
  const text = renderUnits(picked)
  out({
    ok: true, mode: 'range', book: book.id, chapter: n,
    from, to, totalParas: total,
    emittedFrom: picked.length > 0 ? picked[0].n : null,
    emittedTo: picked.length > 0 ? emittedTo : null,
    bytes: byteLen(text), text,
    hasMore: emittedTo < to, nextFrom: emittedTo < to ? emittedTo + 1 : null,
    truncatedBy,
  })
}

try {
  main()
} catch (e) {
  fail(`读取失败：${e && e.message ? e.message : String(e)}`)
}
