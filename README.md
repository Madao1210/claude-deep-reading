# Deep Reading · A Token-Efficient Reading Skill for Claude Code

[中文](README.md) | English

**Token efficiency first**: chapter source text is read only inside forked subagents — the main session receives nothing but explanations and memory.

## The problem it solves

Pasting a long book into a chat chapter by chapter makes tokens grow linearly with the book — by the later chapters, every turn is re-carrying the earlier text. This tool splits "reading" and "recording" into two roles:

| Role | Does | Cost profile |
|---|---|---|
| **Main session** (moderator) | Dispatches tasks, collects explanations, saves memory, keeps the ledger | Nearly flat per chapter, **independent of chapter size** |
| **Forked subagent** (researcher) | Reads one chapter behind closed doors, returns notes + explanation | Grows with chapter size |

Measured (12 chapters, 148,321 characters of a public-domain book, on the author's machine, 2026-09-23):

- The main session grows by only ~**17k tokens per chapter** (steady-state mean 16,996); correlation with chapter size **r = -0.36**
- Source text entered the main session **0 times** across all 12 chapters
- All source-text work is carried by subagents (16.5M full tokens in total, ~95% cache re-reads)

## Features

- **Import**: EPUB / Markdown / directory → per-chapter files (idempotent; an unchanged source is never re-imported)
- **Chapter-by-chapter reading**: the subagent reads the chapter in slices and returns an ordered explanation plus memory with paragraph anchors (`[n]`)
- **Cross-session resume**: state lives on disk; memory carries content hashes, so a changed source invalidates old memory and triggers a re-read
- **Reuse**: already-read chapters are explained from memory — no re-reading
- **Export**: `reading.md` assembled verbatim by script; explanations can be repackaged into an EPUB
- **Usage accounting**: every operation is appended to a ledger; `--report` prints per-chapter numbers

## Quick start

Requirements: Claude Code, Node.js ≥ 18, git.

```bash
git clone <repository-url> deep-reading
cd deep-reading
npm install
```

There are only 3 direct npm dependencies: `@storyteller-platform/epub` (parse EPUB), `turndown` (HTML → Markdown), `yazl` (write EPUB).

Launch Claude Code inside the repository directory and just say:

- "Read this book: /path/to/book.epub" — import and split
- "Deep-read chapter 3" / "Continue reading" — chapter-by-chapter reading (a forked subagent does the reading)
- "Export my reading notes" — assemble `reading.md`
- "Export the explanations as an EPUB" — `export-epub.mjs` assembles `lecture/` into an EPUB

All data lives in `books/<ID>/` (already in `.gitignore`, so it never gets committed; copy `books/` to move your data to another machine).

## Data layout: `books/<ID>/`

| Path | Content | Written by |
|---|---|---|
| `chapters/NNN.md` + `NNN.map.json` | Source facts (paragraph-indexed) | split.mjs only |
| `memory/NNN.md` | Chapter memory (every claim carries an `[n]` anchor) | forked subagent |
| `lecture/NNN.md` | Explanation prose (the source of EPUB exports) | forked subagent |
| `user/NNN.md`, `user/state.md` | User notes; user comprehension state | main session |
| `reader.md` | Reading purpose and preferences | main session |
| `exports/` | Export artifacts | checkpoint / export-epub |
| `usage.jsonl` | Append-only usage ledger | usage.mjs |

## Tools

| Tool | Purpose | Example |
|---|---|---|
| `tools/split.mjs` | Import & split chapters (idempotent) | `node "tools/split.mjs" --src <epub/md/dir> --book <ID>` |
| `tools/read.mjs` | Read-only source access: index / slices / locate / search | `node "tools/read.mjs" --book <ID> --chapter 3 --from 1 --max-bytes 12000` |
| `tools/checkpoint.mjs` | Write memory/lecture/user content; status; export assembly | `node "tools/checkpoint.mjs" status --book <ID>` |
| `tools/usage.mjs` | Usage ledger and report | `node "tools/usage.mjs" --book <ID> --report` |
| `tools/export-epub.mjs` | Assemble `lecture/` explanations into an EPUB | `node "tools/export-epub.mjs" --book <ID>` |

## Hard rules (baked into the skill; some enforced by the tools)

1. Four kinds of information are stored separately: source facts (`chapters/`) | AI interpretation (`memory/`) | user notes (`user/NNN.md`) | user comprehension state (`user/state.md`)
2. Every claim in memory must carry a paragraph anchor (`[n]` or a locate phrase); memory without anchors is refused
3. Quotes are verbatim; when you can't quote exactly, paraphrase and drop the quotes; cross-paragraph inference must be labeled
4. `complete` memory is never rewritten (content-hash + method-version guard)
5. Export is verbatim script assembly only — the model rewrites nothing
6. Chapter source text never enters the main session: reading source text happens only inside forked subagents

## Measured results (2026-09-23)

Full run over a 12-chapter, 148,321-character public-domain book (import → 12 chapters deep-read → export):

- Main session · new: steady state (source docs 4–13) 12,699–20,844, **mean 16,996**; **r = -0.36** against chapter characters
- Main session cacheRead ~0.50M → 0.80M (+~34k per chapter) — a fixed cost that grows with session length, independent of the book
- Subagent · full: 0.82M–2.40M per chapter, driven by the fork's own request count (16–38 per chapter), ~95% of it cache re-reads
- Whole book: main session new **305,077** vs subagent full **16,455,390** (non-cached basis: 305,077 vs 889,182)
- Exported `reading.md`: 269,583 bytes (24 files assembled by script, not a word rewritten)

<details>
<summary>Per-chapter detail table</summary>

The source EPUB's body consists of documents 2–13 (CHAPTER I–XII); rows are numbered by source document.

| Ch. | Source (chars) | Main · new† | Main · cacheRead | Subagent · full | Subagent · non-cached | Fork requests |
|---|---|---|---|---|---|---|
| 2 | 11,731 | 35,092 | 2,111,104 | 1,567,919 | 57,007 | 30 |
| 3 | 11,098 | 100,029 | 600,192 | 678,450 | 57,522 | 14 |
| 4 | 9,804 | 20,121 | 496,896 | 994,104 | 48,824 | 20 |
| 5 | 14,093 | 15,051 | 534,144 | 1,303,541 | 63,221 | 25 |
| 6 | 12,414 | 17,394 | 563,328 | 2,082,593 | 98,465 | 34 |
| 7 | 14,237 | 19,125 | 598,272 | 1,122,712 | 49,432 | 21 |
| 8 | 13,232 | 12,699 | 634,368 | 1,728,424 | 148,648 | 28 |
| 9 | 14,024 | 15,144 | 658,944 | 2,398,317 | 81,517 | 38 |
| 10 | 13,090 | 18,447 | 688,896 | 1,081,381 | 63,909 | 21 |
| 11 | 11,815 | 17,529 | 724,992 | 1,588,464 | 62,960 | 28 |
| 12 | 10,754 | 20,844 | 759,936 | 823,542 | 76,662 | 16 |
| 13 | 12,029 | 13,602 | 799,488 | 1,085,943 | 81,015 | 20 |
| **Total** | **148,321** | **305,077** | **9,170,560** | **16,455,390** | **889,182** | **295** |

† Main · new = input + output + cacheWrite + thinking; chapters 2 and 3 each include a one-off accounting/ops cost (not the reading itself); the steady state starts at chapter 4.

</details>

## Repository layout

```
.
├─ .claude/skills/
│  ├─ deep-reading/           # Entry skill (usable as soon as Claude Code starts in this directory)
│  └─ deep-reading-chapter/   # Single-chapter fork sub-skill
├─ tools/                     # 5 command-line tools (Node, no build step)
├─ books/                     # Your books and reading data (gitignored)
├─ package.json               # 3 direct dependencies
└─ README.md
```

## Installing into an existing project (optional)

Copy the two skill directories under `.claude/skills/` into your project's `.claude/skills/`; put `tools/` and `package.json` anywhere and run `npm install`; then rewrite the `tools/…` command prefix in both skill files to the real path. The two skills must live in the same skills directory (the forked chapter skill has to be callable by the `Skill` tool).

## Known limitations

- **The prompt layer is Chinese.** The two skill files, the memory-template headings and the tools' status/error messages are all written in Chinese, so with an English book the explanations and memory still come out in Chinese by default. The data pipeline itself is language-agnostic — it has been run end-to-end on an English novel (12 chapters of *Alice's Adventures in Wonderland*) as well as on Chinese books. An English prompt variant is not included yet.
- Chapter titles that don't begin with a "Chapter" marker get a Chinese `第N章` prefix, and exported EPUBs are tagged `zh-CN`. Cosmetic only.
- Source formats: EPUB / Markdown; PDF is not supported
- No cross-chapter analysis, key terms/entities, annotation visualization or companion-reading mode
- The main session's cacheRead still grows as the session gets longer (a fixed cost independent of the book)
- The interfaces were polished for the author's own use and may keep changing

## License

[MIT](LICENSE)
