#!/usr/bin/env node
// split.mjs —— 把 EPUB / Markdown 文件 / Markdown 目录导入为 books/<ID>/ 结构
// 产出：book.json、index.md、chapters/NNN.md（[n] 段落编号）、chapters/NNN.map.json
// 特性：源哈希+工具版本幂等；临时目录构建后整目录原子换入；保留既有 memory/user/exports/usage.jsonl
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Epub } from '@storyteller-platform/epub'
import TurndownService from 'turndown'

const TOOL_NAME = 'deep-reading-split'
const TOOL_VERSION = '0.1.1'
const SCHEMA_VERSION = 1

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOOKS_DIR = path.join(ROOT, 'books')

const turndown = new TurndownService({ headingStyle: 'atx' })

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
    if (a === '--force') { o.force = true; continue }
    if (!a.startsWith('--')) fail(`无法识别的参数：${a}`)
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

function toMarkdown(xhtml) {
  const cleaned = xhtml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  return turndown.turndown(cleaned).trim()
}

// Markdown → 块列表（以空行分块；去掉行尾空白；不做任何改写）
function splitBlocks(markdown) {
  return markdown
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/[ \t]+$/gm, '').trim())
    .filter(Boolean)
}

// 取第一个某个级别的标题行并返回 {title, body}；没找到时 title=null、body 原样
function extractHeading(text, re) {
  const m = text.match(re)
  if (!m) return { title: null, body: text }
  const title = m[0].replace(/^#{1,6}[ \t]+/, '').trim()
  return { title, body: text.slice(0, m.index) + text.slice(m.index + m[0].length) }
}

function renderChapter(chapterNo, title, blocks) {
  const header = `# ${displayTitle(chapterNo, title)}`
  const body = blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n\n')
  return { text: `${header}\n\n${body}\n`, paras: blocks.length }
}

// 标题里已经带"第X章/Chapter"标记时不再重复前缀
function displayTitle(n, title) {
  return /^第\s*[0-9一二三四五六七八九十百零两]+\s*[章回节话]|^chapter\b/i.test(title)
    ? title
    : `第${n}章 ${title}`
}

// ---------- 三种源的采集：都返回 [{title, body, sourceDescriptor}] ----------

async function collectFromEpub(src) {
  // 库只读 EPUB 3；遇到 EPUB 2 源先升级到临时副本再读
  let epub
  try {
    epub = await Epub.from(src)
  } catch (e) {
    if (!/EPUB 2/.test(e && e.message ? e.message : '')) throw e
    epub = await Epub.upgrade(src)
  }
  try {
    const epubTitle = (await epub.getTitle())?.trim() || path.basename(src, path.extname(src))
    const spineItems = await epub.getSpineItems()
    const chapters = []
    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i]
      if (!item.mediaType || !item.mediaType.includes('xhtml')) continue
      const xhtml = await epub.readItemContents(item.id, 'utf-8')
      const markdown = toMarkdown(xhtml)
      if (!markdown) continue
      const { title, body } = extractHeading(markdown, /^#{1,6}[ \t]+(.+)$/m)
      chapters.push({
        title: title || `第${chapters.length + 1}节`,
        body,
        sourceDescriptor: { type: 'epub', path: src, spineIndex: i, href: item.href || '' },
      })
    }
    return { bookTitle: epubTitle, sourceType: 'epub', chapters }
  } finally {
    epub.discardAndClose()
  }
}

function collectFromMdFile(src, titleOpt) {
  const raw = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n')
  const headings = [...raw.matchAll(/^#[ \t]+.+$/gm)]
  const chapters = []
  if (headings.length === 0) {
    chapters.push({
      title: titleOpt || path.basename(src, path.extname(src)),
      body: raw,
      sourceDescriptor: { type: 'md', path: src },
    })
  } else {
    const pre = raw.slice(0, headings[0].index).trim()
    if (pre) {
      chapters.push({ title: '前言', body: pre, sourceDescriptor: { type: 'md', path: src } })
    }
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index + headings[i][0].length
      const end = i + 1 < headings.length ? headings[i + 1].index : raw.length
      chapters.push({
        title: headings[i][0].replace(/^#[ \t]+/, '').trim(),
        body: raw.slice(start, end),
        sourceDescriptor: { type: 'md', path: src },
      })
    }
  }
  return {
    bookTitle: titleOpt || (chapters[0] && chapters[0].title) || path.basename(src, path.extname(src)),
    sourceType: 'md',
    chapters,
  }
}

function collectFromDir(src, titleOpt) {
  const files = fs.readdirSync(src).filter((f) => f.toLowerCase().endsWith('.md')).sort()
  if (files.length === 0) fail(`目录里没有 .md 文件：${src}`)
  const hashOfSet = sha256(files.map((f) => f + '\0' + sha256File(path.join(src, f))).join('\n'))
  const chapters = files.map((f) => {
    const raw = fs.readFileSync(path.join(src, f), 'utf8').replace(/\r\n/g, '\n')
    const { title, body } = extractHeading(raw, /^#[ \t]+.+$/m)
    return {
      title: title || path.basename(f, '.md'),
      body,
      sourceDescriptor: { type: 'dir', path: src, file: f },
    }
  })
  return {
    bookTitle: titleOpt || path.basename(src),
    sourceType: 'dir',
    chapters,
    sourceHashOverride: hashOfSet,
  }
}

// ---------- 主流程 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.src) fail('缺少 --src（EPUB / .md 文件 / 含 .md 的目录）')
  if (!args.book) fail('缺少 --book（书籍 ID，建议简短英文：字母、数字、-、_）')
  const id = args.book
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    fail('书籍 ID 不合法：只允许字母/数字/._-，且以字母或数字开头（不要用中文或路径分隔符）')
  }

  const src = path.resolve(args.src)
  if (!fs.existsSync(src)) fail(`源不存在：${src}`)

  const stat = fs.statSync(src)
  let collected
  let sourceSha
  if (stat.isDirectory()) {
    collected = collectFromDir(src, args.title)
    sourceSha = collected.sourceHashOverride
  } else if (src.toLowerCase().endsWith('.epub')) {
    collected = await collectFromEpub(src)
    sourceSha = sha256File(src)
  } else if (src.toLowerCase().endsWith('.md')) {
    collected = collectFromMdFile(src, args.title)
    sourceSha = sha256File(src)
  } else {
    fail(`不支持的源类型：${src}（只支持 .epub / .md / 目录）`)
  }

  if (collected.chapters.length === 0) fail('源里没有可用章节（EPUB 正文为空，或 Markdown 无内容）')

  const bookDir = path.join(BOOKS_DIR, id)
  const sourceInfo = { type: collected.sourceType, path: src, sha256: sourceSha }

  // 读取旧 book.json（用于幂等判断与状态携带）
  let oldBook = null
  const oldBookPath = path.join(bookDir, 'book.json')
  if (fs.existsSync(oldBookPath)) {
    try { oldBook = JSON.parse(fs.readFileSync(oldBookPath, 'utf8')) } catch { oldBook = null }
  }

  // 幂等：源哈希、工具版本、全部章节文件都一致 → 跳过
  if (oldBook && !args.force) {
    const sameSource = oldBook.source && oldBook.source.sha256 === sourceSha
    const sameTool = oldBook.tool && oldBook.tool.version === TOOL_VERSION
    let filesOk = Array.isArray(oldBook.chapters) && oldBook.chapters.length === collected.chapters.length
    if (filesOk) {
      for (const ch of oldBook.chapters) {
        const p = path.join(bookDir, ch.file)
        if (!fs.existsSync(p) || sha256File(p) !== ch.sha256) { filesOk = false; break }
      }
    }
    if (sameSource && sameTool && filesOk) {
      out({
        ok: true, skipped: true, reason: 'unchanged', id, title: oldBook.title,
        dir: bookDir, source: sourceInfo, chapterCount: oldBook.chapters.length,
        chapters: oldBook.chapters.map((c) => ({
          n: c.n, title: c.title, file: c.file, paras: c.paras, chars: c.chars,
          sha256: c.sha256, state: c.state,
        })),
      })
      return
    }
  }

  // 在临时目录构建
  fs.mkdirSync(BOOKS_DIR, { recursive: true })
  const tmpDir = path.join(BOOKS_DIR, `.import-${id}-${rand6()}`)
  fs.mkdirSync(path.join(tmpDir, 'chapters'), { recursive: true })

  const chaptersMeta = []
  for (let i = 0; i < collected.chapters.length; i++) {
    const n = i + 1
    const ch = collected.chapters[i]
    const blocks = splitBlocks(ch.body)
    const { text } = renderChapter(n, ch.title, blocks)
    const file = `chapters/${pad3(n)}.md`
    fs.writeFileSync(path.join(tmpDir, file), text, 'utf8')

    const map = {
      schemaVersion: SCHEMA_VERSION,
      book: id,
      chapter: n,
      source: ch.sourceDescriptor,
      paras: blocks.map((b, bi) => ({
        n: bi + 1,
        blockIndex: bi,
        chars: b.length,
        head: b.slice(0, 30),
      })),
    }
    fs.writeFileSync(path.join(tmpDir, `chapters/${pad3(n)}.map.json`), JSON.stringify(map, null, 2) + '\n', 'utf8')

    chaptersMeta.push({
      n,
      title: ch.title,
      file,
      sha256: sha256(Buffer.from(text, 'utf8')),
      paras: blocks.length,
      chars: text.length,
      state: 'unanalyzed',
      memory: null,
    })
  }

  // 携带旧状态：章节文件哈希与旧记忆的记录一致时，保留 analyzed/覆盖信息
  if (oldBook) {
    for (const ch of chaptersMeta) {
      const old = (oldBook.chapters || []).find((c) => c.n === ch.n)
      if (old && old.memory && old.memory.sourceSha256 === ch.sha256) {
        ch.state = old.state
        ch.memory = old.memory
      }
    }
  }

  // index.md
  const importedAt = new Date().toISOString()
  const indexLines = [
    `# 《${collected.bookTitle}》目录`,
    '',
    `- 来源：${sourceInfo.type}（${sourceInfo.path}）`,
    `- 导入：${importedAt}`,
    `- 章节数：${chaptersMeta.length}`,
    '',
    '## 章节',
    '',
    ...chaptersMeta.map((c) =>
      `- ${pad3(c.n)} ${displayTitle(c.n, c.title)} — ${c.paras} 段 · ${c.chars} 字符 · ${c.state === 'analyzed' ? '已分析' : '未分析'}`),
    '',
  ]
  fs.writeFileSync(path.join(tmpDir, 'index.md'), indexLines.join('\n'), 'utf8')

  // 携带旧用户数据（记忆、用户区、导出、用量账本）
  if (fs.existsSync(bookDir)) {
    for (const rel of ['memory', 'user', 'exports']) {
      const old = path.join(bookDir, rel)
      if (fs.existsSync(old)) fs.cpSync(old, path.join(tmpDir, rel), { recursive: true })
    }
    const oldUsage = path.join(bookDir, 'usage.jsonl')
    if (fs.existsSync(oldUsage)) fs.copyFileSync(oldUsage, path.join(tmpDir, 'usage.jsonl'))
    const oldCursor = path.join(bookDir, '.usage-cursor.json')
    if (fs.existsSync(oldCursor)) fs.copyFileSync(oldCursor, path.join(tmpDir, '.usage-cursor.json'))
    const oldReader = path.join(bookDir, 'reader.md')
    if (fs.existsSync(oldReader)) fs.copyFileSync(oldReader, path.join(tmpDir, 'reader.md'))
  }

  // book.json 最后写（作为"构建完成"标记）
  const bookJson = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: collected.bookTitle,
    source: sourceInfo,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    importedAt,
    chapters: chaptersMeta,
  }
  fs.writeFileSync(path.join(tmpDir, 'book.json'), JSON.stringify(bookJson, null, 2) + '\n', 'utf8')

  // 原子换入
  if (fs.existsSync(bookDir)) {
    const oldDir = path.join(BOOKS_DIR, `.old-${id}-${rand6()}`)
    fs.renameSync(bookDir, oldDir)
    try {
      fs.renameSync(tmpDir, bookDir)
    } catch (e) {
      fs.renameSync(oldDir, bookDir)
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw e
    }
    fs.rmSync(oldDir, { recursive: true, force: true })
  } else {
    fs.renameSync(tmpDir, bookDir)
  }

  out({
    ok: true, skipped: false, id, title: collected.bookTitle, dir: bookDir,
    source: sourceInfo, chapterCount: chaptersMeta.length,
    chapters: chaptersMeta.map((c) => ({
      n: c.n, title: c.title, file: c.file, paras: c.paras, chars: c.chars,
      sha256: c.sha256, state: c.state,
    })),
  })
}

main().catch((e) => fail(`拆章失败：${e && e.message ? e.message : String(e)}`))
