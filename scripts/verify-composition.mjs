/**
 * 组合自检：把本包的 bundle 补丁 `cordis.patch.yml` 当成 loader 那样读一遍。
 *
 * 0.1.7 之前这个文件读的是 `presets/short-story/agent.cordis.yml`；现在 preset 是**普通的
 * loader 行**，由本包的补丁插进 profile 的组合里，所以自检对象换成了补丁文件本身：
 * `- insert:` → preset 声明行（`@deepseek-ai/dsh-agent-preset`）→ 那一行的
 * `config.plugins` 才是模式全部的子插件行。
 *
 * 它回答的不是"文件能不能解析"，而是六个**只在装配时才会暴露**的问题：
 *   1. 每行的 `!!js` 能不能**编译**——语法错误要等到那一行挂载时才炸，而那一炸的表现
 *      是 preset 在 roster 里变成 broken、模式静默消失；
 *   2. `!!js` 里的值有没有被 YAML 转义改写（`'\n'` 在双引号标量里会变成真换行）；
 *   3. 双引号标量里有没有反斜杠转义（同一个坑的预防性检查）；
 *   4. 每行的 `config` 能不能过插件自己的 Config schema；
 *   5. `toolFilter` 点名的工具是不是本组合真实注册过的（名字错了会在子代理创建窗口抛错
 *      ＝那次派发直接失败）；
 *   6. 审读员有没有被误授权写文件、呈现或再委派，人设是不是真来自它自己的文件，
 *      以及这个补丁在**别的机器上**还装不装得上（行长不被插值、包内路径一律运行时解析）。
 *
 * 用法：node scripts/verify-composition.mjs [--composition <file>]
 * 退出码 0 = 全过；1 = 有失败项（打印到 stderr）。
 * `--composition` 只为一件事：**在副本上验证失败路径**——把补丁改坏（截断、写回 `'\n'`、
 * 改错工具名、把审读员改成 one-shot），脚本必须报错，而这些改动不该留在仓库里。
 *
 * 两件它**不能**代替的事：真实会话里的工具清单，以及子代理真的能起来。
 *
 * **它需要 harness**：插件源码、Config schema 与 loader 的 YAML 方言（js-yaml +
 * `entryListSchema`）都从 `@deepseek-ai/*` 取，而本包没有依赖、仓库里没有 node_modules。
 * 所以要么就在 harness 自己的进程里跑，要么用 `DSH_HARNESS=<harness 目录>` 指一个真实目录：
 *
 *   $env:DSH_HARNESS = "C:\Users\<你>\AppData\Local\Temp\dsh-e2e\dsh"
 *   node scripts/verify-composition.mjs
 *
 * 桌面版把 harness 装在 Electron 的 `resources/app.asar` 里，而**普通 Node 读不了 asar
 * 内部的模块路径**（那是 Electron 才认识的补丁），所以必须先把那一层运行时解压成真实目录。
 * 找不到 harness 时这个脚本会直接报错退出——不静默降级：它的价值全在"用真实的插件与
 * 真实的解析器校验"，拿不到就必须说自己不可信。
 *
 * **零依赖**（和这个包本身一样）：自带一个只认补丁文件实际用到子集的 YAML 读取器
 * ——顶层补丁条目（`- insert:`）、嵌套的插件行、`key: value`、`|-` 字面块标量、
 * `- 值` 标量序列、`[...]` 流序列、`#` 注释和 `!!js` 标量标记。它是**校验器**不是
 * 通用解析器：遇到不认识的形状直接报错退出，而不是猜。**但它不做 YAML 转义**，所以凡是
 * "值里可能出现转义"的判断，都必须以 loader 自己的解析器（js-yaml + `entryListSchema`）
 * 为准——第 1c 节就是为此存在的，v1.1.3 正是栽在只有那个解析器才看得出的错误上。
 *
 * 还有一件只能靠运行时才知道的事：`!!js` 求值时的 `baseUrl` 是 **profile 目录**，
 * 不是包目录（见文件头第 2/3 条），所以包内路径全是
 * `createRequire(baseUrl).resolve('dsh-story-mode/package.json')` 问出来的。第 1d 节
 * 为此搭了一个临时目录 + junction，让这些表达式**真的跑一遍**——不搭的话它们只会
 * MODULE_NOT_FOUND，而脚本也就查不出"文件到底在不在"。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
// 目录形式的 baseUrl 必须带**尾分隔符**，否则 Node 会把目录当成文件解析。
// 这里绝不能用 `join(...) + '\\'`：反斜杠只是 Windows 的分隔符，在 macOS／Linux
// 上它会被当成文件名的一部分，路径会变成 `<root>/skills/...` 这类错位置，五个
// 审读员的 `!!js` 全部 ENOENT——看起来像"行坏了"，实际是自检脚本自己走错目录
// （v1.2.1 修过一次这个 bug）。统一用 `pathToFileURL(dir + sep)`。
/** 包内技能根：两份技能都从这里挂载（`skills/short-story`、`skills/writing-style-contract`）。 */
const SKILLS_DIR = join(ROOT, 'skills')

// ── 报告通道 ────────────────────────────────────────────────────────────────
//
// 走同步写而不是 console.log + process.exit：管道上 stdout 是异步写，
// `process.exit()` 会把还没冲出去的失败信息截掉——而"失败必须看得见"正是这个脚本的意义。
const failures = []
const notes = []
const fail = (message) => failures.push(message)
function emit(fd, text) {
  try {
    writeSync(fd, `${text}\n`)
  } catch { /* 输出管道没了也只能认了 */ }
}
const out = (text) => emit(1, text)
const err = (text) => emit(2, text)
const die = (message) => {
  err(`[FAIL] ${message}`)
  process.exit(1)
}

/** 审读员工具名 → 它的固定人设文件；组合里每一行都按这张表读文件。 */
const ROLE_FILES = {
  subagent_review_b1: 'b1-cold-read.md',
  subagent_review_b2: 'b2-story-logic.md',
  subagent_review_b3: 'b3-reading-experience.md',
  subagent_review_b4: 'b4-style-execution.md',
  subagent_review_b5: 'b5-physical-continuity.md',
}
/** 角色目录：`skills/short-story/references/reviewers/`。 */
const REVIEWER_DIR = join(SKILLS_DIR, 'short-story', 'references', 'reviewers')

// ── 命令行 ──────────────────────────────────────────────────────────────────

function compositionFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--composition') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0) die('--composition 后面要跟一个补丁文件路径')
      return resolve(value)
    }
    if (arg.startsWith('--composition=')) {
      const value = arg.slice('--composition='.length)
      if (value.length === 0) die('--composition= 后面要跟一个补丁文件路径')
      return resolve(value)
    }
    die(`不认识的参数 ${arg}（只支持 --composition <file>）`)
  }
  return join(ROOT, 'cordis.patch.yml')
}

const COMPOSITION = compositionFromArgv(process.argv.slice(2))

// ── YAML 子集读取 ───────────────────────────────────────────────────────────

class YamlSubsetError extends Error {}

/** 去掉行尾注释；引号里的 `#` 不算注释。 */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote === null) {
      if (char === '"' || char === "'") quote = char
      else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
    } else if (char === quote) {
      quote = null
    }
  }
  return line
}

function unquote(value, path) {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner.length === 0) return []
    return inner.split(',').map((item) => item.trim())
  }
  if (value.startsWith('{') || value.startsWith('[')) {
    throw new YamlSubsetError(`${path}: 只支持单行流序列 […]，不认 ${value.slice(0, 1)} 开头的多行结构`)
  }
  return value
}

function parseScalar(text, path) {
  const value = text.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value === '!!js' || value.startsWith('!!js ')) {
    const source = value.slice(4).trim()
    if (source.length === 0) throw new YamlSubsetError(`${path}: !!js 后面没有表达式（本文件里它必须是同一行的标量）`)
    return { __jsExpr: unquote(source, path) }
  }
  return unquote(value, path)
}

/** 已读到的条目数——三者用途不同，分开记。 */
let rowEntriesRead = 0 // 所有 `- id:` 行（含 preset 声明行与分组子行）
let patchEntriesRead = 0 // 补丁文件顶层的 `- <key>:` 条目
let scalarItemsRead = 0 // `- 值` 形式的标量序列项（例如 customSkillDirs）

/**
 * 块标量正文占用的行号区间（0 基，闭区间）。
 *
 * "文件里有多少个行首 `- `"这条交叉检查要用它把块标量正文排除掉：人设正文里出现一行
 * Markdown 列表不是新条目，把它算成条目会让脚本对着正确的文件报错。
 */
const blockScalarRanges = []

/** 读取 `|-` / `>-` 之类的块标量，返回 [文本, 下一个行号]。 */
function readBlockScalar(lines, index, cursor, folded) {
  const first = index
  const collected = []
  let contentIndent = null
  for (;;) {
    const look = index + 1
    if (look >= lines.length) break
    const contentRaw = lines[look]
    if (contentRaw.trim() === '') { collected.push(''); index = look; continue }
    const contentLeading = contentRaw.length - contentRaw.trimStart().length
    if (contentLeading <= cursor) break
    if (contentIndent === null) contentIndent = contentLeading
    if (contentLeading < contentIndent) break
    collected.push(contentRaw.slice(contentIndent))
    index = look
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  if (index > first) blockScalarRanges.push([first + 1, index])
  return [folded ? collected.join(' ').trim() : collected.join('\n'), index]
}

/**
 * 从 `from` 起第一条**有内容**的行（空行与整行注释都跳过）。
 *
 * `key:` 后面挂的是什么形状，只能看紧跟其后的第一条内容行——中间夹几行注释是常态
 * （组合里每个插件行前面都有一段说明），把注释行当成子块的开头会让读取器把 `- id: …`
 * 读成 `- id` 这个键，然后在下一行的缩进上炸掉（v1.1.4 的读取器就是这么挂的）。
 */
function firstContentLine(lines, from) {
  for (let index = from; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    const text = stripComment(raw.slice(indent))
    if (text.trim() === '') continue
    return { index, indent, text }
  }
  return null
}

/**
 * 已经消费到的最远行号。
 *
 * 这个读取器只认补丁实际用到的 YAML 子集，所以"少读/重复读一行"是它最危险的
 * 失败形态——它会让校验脚本报出与真实装配无关的结论。每次嵌套解析返回时都用
 * 最远行号交叉检查：一旦发现解析器回头重读已经消费过的行，立即报错退出。
 */
let furthest = 0
function claim(index, where) {
  if (index < furthest) {
    throw new YamlSubsetError(`第 ${index + 1} 行被重复消费（最远已到第 ${furthest + 1} 行，${where}）——读取器与文件形状不符`)
  }
  furthest = index
}

/**
 * 读取块序列。三种模式：
 *   `rows`    插件行（必须有 `id`）；
 *   `patches` 顶层补丁条目（`- insert:`，没有 id，也不该有别的形状）；
 *   `scalars` `- 值` 形式的标量序列。
 */
function parseRows(lines, start, indent, mode = 'rows') {
  const rows = []
  let index = start
  while (index < lines.length) {
    const raw = lines[index]
    if (raw.trim() === '') { index += 1; continue }
    const leading = raw.length - raw.trimStart().length
    if (leading < indent) break
    if (leading > indent) throw new YamlSubsetError(`第 ${index + 1} 行缩进比它的父键更深，但这里期待的是同级条目`)
    const line = stripComment(raw.slice(indent))
    if (line.trim() === '') { claim(index, '块序列里的注释行'); index += 1; continue }
    if (!line.startsWith('- ')) break
    claim(index, '块序列条目')

    if (mode === 'scalars') {
      rows.push(parseScalar(line.slice(2).trim(), `第 ${index + 1} 行`))
      scalarItemsRead += 1
      index += 1
      continue
    }

    const row = {}
    const cursor = indent + 2
    let pending = line.slice(2).trim()
    for (;;) {
      let text
      if (pending.length > 0) { text = pending; pending = '' }
      else {
        index += 1
        if (index >= lines.length) break
        const nextRaw = lines[index]
        if (nextRaw.trim() === '') continue
        const nextIndent = nextRaw.length - nextRaw.trimStart().length
        // 缩进退回上一级＝这一行归外层 `parseRows`。**不能减 index**：减了就会在
        // 同一个条目上原地循环，直到把堆吃光（实测把 2 GB 吃完）。
        if (nextIndent < cursor) break
        if (nextIndent > cursor) throw new YamlSubsetError(`第 ${index + 1} 行的缩进（${nextIndent}）与 ${cursor} 不符`)
        text = stripComment(nextRaw.slice(cursor))
        if (text.trim() === '') continue
      }
      const separator = text.indexOf(':')
      if (separator < 0) throw new YamlSubsetError(`第 ${index + 1} 行不是 key: value：${text}`)
      const key = text.slice(0, separator).trim()
      const rest = text.slice(separator + 1).trim()
      if (rest === '|-' || rest === '|' || rest === '>-' || rest === '>') {
        const [block, next] = readBlockScalar(lines, index, cursor, rest === '>' || rest === '>-')
        row[key] = block
        index = next
        continue
      }
      if (rest === '') {
        const child = firstContentLine(lines, index + 1)
        if (child !== null && child.indent > cursor) {
          // `- 值`（没有 `key:`）是标量序列；`- id: …` 才是插件行。
          const childMode = child.text.startsWith('- ') && !/^-\s+[\w-]+\s*:/.test(child.text) ? 'scalars' : 'rows'
          const [nested, next] = child.text.startsWith('- ')
            ? parseRows(lines, child.index, child.indent, childMode)
            : parseMapping(lines, child.index, child.indent)
          row[key] = nested
          index = Math.max(next - 1, index)
          if (index < child.index) index = child.index
          continue
        }
        row[key] = ''
        continue
      }
      row[key] = parseScalar(rest, `第 ${index + 1} 行`)
    }
    if (mode === 'patches') {
      // 顶层条目是**补丁**不是插件行：它没有 id，只有 insert（以及各字段覆写）。
      // 既没有 insert 也没有 id 的条目说明这个读取器已经不认识文件了，直接失败。
      if (!('insert' in row) && !('id' in row)) {
        throw new YamlSubsetError(`第 ${index + 1} 行附近：顶层补丁条目既没有 insert 也没有 id，读取器不认识这种形状`)
      }
      rows.push(row)
      patchEntriesRead += 1
      continue
    }
    // 组合的每一行都必须有 id：没有 id 的条目只能是嵌套序列（例如 customSkillDirs），
    // 把它当成行会让"行数对不对"的检查失去意义，所以这里直接失败。
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new YamlSubsetError(`第 ${index + 1} 行附近：缩进 ${indent} 的条目没有 id，说明读取器把嵌套序列当成了插件行`)
    }
    rows.push(row)
    rowEntriesRead += 1
    if (process.env.VERIFY_TRACE === '1') err(`  [row ${rowEntriesRead}] line ${index + 1} id=${row.id}`)
  }
  return [rows, index]
}

/** 读取一组同级 `key: value`。 */
function parseMapping(lines, start, indent) {
  const map = {}
  let index = start
  while (index < lines.length) {
    const raw = lines[index]
    if (raw.trim() === '') { index += 1; continue }
    const leading = raw.length - raw.trimStart().length
    if (leading < indent) break
    const line = stripComment(raw.slice(indent))
    if (line.trim() === '') { index += 1; continue }
    if (leading > indent) throw new YamlSubsetError(`第 ${index + 1} 行的缩进与同级的 ${indent} 不符`)
    const separator = line.indexOf(':')
    if (separator < 0) break
    const key = line.slice(0, separator).trim()
    const rest = line.slice(separator + 1).trim()
    if (rest === '|-' || rest === '|' || rest === '>-' || rest === '>') {
      const [block, next] = readBlockScalar(lines, index, indent, rest === '>' || rest === '>-')
      map[key] = block
      index = next
      continue
    }
    if (rest === '') {
      const child = firstContentLine(lines, index + 1)
      if (child !== null && child.indent > indent) {
        const childMode = child.text.startsWith('- ') && !/^-\s+[\w-]+\s*:/.test(child.text) ? 'scalars' : 'rows'
        const [nested, next] = child.text.startsWith('- ')
          ? parseRows(lines, child.index, child.indent, childMode)
          : parseMapping(lines, child.index, child.indent)
        map[key] = nested
        // 永远向前走：嵌套解析器在原地返回时，至少跨过刚看的那一行。
        index = Math.max(next, child.index + 1)
        continue
      }
      map[key] = ''
      index += 1
      continue
    }
    map[key] = parseScalar(rest, `第 ${index + 1} 行`)
    index += 1
  }
  return [map, index]
}

/** 顶层是**补丁列表**（`- insert:`），不是插件行列表。 */
function parsePatchFile(text) {
  return parseRows(text.replace(/^\uFEFF/, '').split(/\r?\n/), 0, 0, 'patches')[0]
}

// ── 1. 读并解析 ─────────────────────────────────────────────────────────────

const raw = (() => {
  try {
    return readFileSync(COMPOSITION, 'utf8')
  } catch (error) {
    // 路径写错时要说清楚是**哪一个**文件，而不是抛一个只有 errno 的栈。
    return die(`补丁文件读不动 ${COMPOSITION}：${error.message}`)
  }
})()
let patchEntries
try {
  patchEntries = parsePatchFile(raw)
} catch (error) {
  die(`组合读不动：${error.message}`)
}
if (patchEntries.length === 0) die('补丁文件里一个顶层条目都没读出来——空文件不是"没有补丁"')
// 读取器只认子集；形状对不上时必须响亮地失败，而不是少读几行之后报"通过"。
// 计数用 `[ \t]*` 而不是 `\s*`：多行模式下 `\s` 会跨行吞掉换行，把整份文件读成 0 条。
const declaredInserts = (raw.match(/^[ \t]*- insert:/gm) ?? []).length
if (declaredInserts !== patchEntriesRead) {
  die(`YAML 读取器读到的补丁条目数与文件不符：文件里 ${declaredInserts} 个 "- insert:"，读出 ${patchEntriesRead} 个`)
}
const declaredRows = (raw.match(/^[ \t]*- id:/gm) ?? []).length
if (declaredRows !== rowEntriesRead) {
  die(`YAML 读取器读到的行数与文件不符：文件里 ${declaredRows} 个 "- id:"，读出 ${rowEntriesRead} 个`)
}
// 更强的一条：**所有**行首 `- ` 条目都要有归属（补丁条目／插件行／标量序列项）。
// 少一条就说明读取器跳过了文件里真实存在的一行——那正是"部分解析也报通过"的入口。
const dashLineIndexes = raw.split(/\r?\n/)
  .map((line, index) => (/^[ \t]*- /.test(line)
    && !blockScalarRanges.some(([from, to]) => index >= from && index <= to) ? index : -1))
  .filter((index) => index >= 0)
const entriesRead = rowEntriesRead + patchEntriesRead + scalarItemsRead
if (dashLineIndexes.length !== entriesRead) {
  die(`YAML 读取器没读完文件：行首 "- " 条目 ${dashLineIndexes.length} 个，只读出 ${entriesRead} 个`
    + `（插件行 ${rowEntriesRead} + 补丁条目 ${patchEntriesRead} + 标量项 ${scalarItemsRead}）`)
}
notes.push(`组合 ${COMPOSITION}：补丁条目 ${patchEntriesRead} 个、行 ${rowEntriesRead} 行（含 preset 声明行与分组子行）、`
  + `标量序列项 ${scalarItemsRead} 个`)

// ── 1b. 找 harness（插件源码、Config schema、loader 的 YAML 方言都从它取）────

/**
 * 找 `@deepseek-ai/*` 的地方。
 *
 * 本包**没有依赖**（连 schemastery 都不 import），所以仓库里没有 node_modules 可查；
 * 而那些插件装在 harness 自己的 node_modules 下。顺序是：脚本自己解析得到的位置
 * → `DSH_HARNESS=<harness 目录>` → 桌面版的默认安装路径。**找不到就报错，不静默降级**：
 * 这个脚本的价值全在"用真实的插件与真实的解析器校验"，拿不到就必须说自己不可信。
 *
 * 桌面版的 harness 住在 Electron 的 `resources/app.asar` 里，而**普通 Node 读不了 asar
 * 内部的模块路径**（`createRequire` 会一路 MODULE_NOT_FOUND，asar 是 Electron 的补丁
 * 才认识的东西）。要跑这个脚本，先把那一层运行时解压成真实目录，再指过来。
 */
function resolveHarnessRequire() {
  const candidates = []
  // 在 harness 自己启动的进程里（或装了 workspace 链接时），这一条就能命中；仓库里没有
  // node_modules 时它会解析失败——仍然列进"试过的位置"，好让失败信息说的是实话。
  candidates.push({ require: createRequire(import.meta.url), label: '脚本自身的解析路径' })
  const explicit = process.env.DSH_HARNESS
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const directory = resolve(explicit.trim())
    candidates.push({
      require: createRequire(pathToFileURL(join(directory, 'package.json')).href),
      label: `DSH_HARNESS=${directory}`,
    })
  }
  candidates.push({
    require: createRequire('file:///C:/Program%20Files/DSH%20Desktop/resources/app/package.json'),
    label: '桌面版默认安装路径',
  })
  const found = []
  for (const candidate of candidates) {
    try {
      candidate.require.resolve('@deepseek-ai/dsh-tool-fs/package.json')
      found.push(candidate)
    } catch { /* 换下一个候选 */ }
  }
  return { found, candidates }
}

const harness = resolveHarnessRequire()
if (harness.found.length === 0) {
  err('[FAIL] 找不到 harness 的 node_modules，无法读取插件源码、Config schema 与 loader 的 YAML 方言。')
  err('  用 DSH_HARNESS=<harness 目录> 指给它，例如：')
  err('    $env:DSH_HARNESS = "C:\\Users\\<你>\\AppData\\Local\\Temp\\dsh-e2e\\dsh"')
  err('  注意：harness 若只存在于 Electron 的 app.asar 里，普通 Node 读不了 asar 内部的模块路径，')
  err('  必须先把那一层运行时解压成真实目录（解出来的目录里应当有 package.json 与 node_modules）。')
  err(`  试过的位置：${harness.candidates.map((candidate) => candidate.label).join('、')}`)
  process.exit(1)
}
const harnessRequire = harness.found[0].require
notes.push(`插件源码与解析器来自：${harness.found[0].label}`
  + `${harness.found.length > 1 ? `（另有 ${harness.found.length - 1} 处同样可用）` : ''}`)

// ── 1c. 与 loader 同款解析器交叉验证 ────────────────────────────────────────
//
// v1.1.3 的事故就藏在这一步：`persona: !!js "… return role + '\n' + contract; …"`
// 里的 `\n` 被 **YAML 双引号标量**先解析成真正的换行符，JS 源码于是跨行、编译报
// `Invalid or unexpected token`——而 preset 挂载失败会让 roster 里那一条变成 broken，
// 文件形状却完全合法。**本脚本自己的读取器不做 YAML 转义**，所以它当时看不出问题。
// 凡涉及"值里出现转义"的判断，都必须以 loader 的解析器为准。
function loadLoaderDialect() {
  try {
    const jsYaml = harnessRequire('js-yaml')
    const include = harnessRequire('@deepseek-ai/cordis-plugin-include')
    if (typeof include.entryListSchema === 'undefined') return { error: 'entryListSchema 未导出' }
    return { load: jsYaml.load, schema: include.entryListSchema }
  } catch (error) {
    return { error: error.message }
  }
}

/** 取出一行 config 里所有 `!!js` 表达式（标记对象或数组元素都可能带）。 */
function jsExprs(value, found = []) {
  if (value instanceof Object && '__jsExpr' in value) found.push(value.__jsExpr)
  else if (Array.isArray(value)) for (const item of value) jsExprs(item, found)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) jsExprs(item, found)
  return found
}
const isJsExpr = (value) => value instanceof Object && '__jsExpr' in value

/**
 * 只编译、不执行：把一个 `!!js` 表达式按**表达式位置**编出来。
 *
 * 这一句是"语法错误必须在自检里报掉"的全部实现：`new Function(…)` 只编译不调用，
 * 所以对一个要读文件的表达式也不会产生副作用。用严格模式 + `return (…)` 是刻意的——
 * v1.1.3 那种被 YAML 转义改成跨行字符串字面量的源码，正是在这里报
 * `Invalid or unexpected token`。真正的求值在 1d 用 loader 自己那套形式做。
 */
function compileExpression(source) {
  // `baseUrl` 走参数而不是外层作用域：严格模式下的 `new Function` 不会闭包捕获
  // 模块作用域的绑定，写成自由变量会直接 ReferenceError。
  return new Function('ctx', 'baseUrl', 'process', `"use strict"; return (${source});`)
}

/** 摊平一行行：分组行（`group: true`）递归进它的 `config`，路径拼成 `分组/子行`。 */
function flattenRows(list, prefix) {
  const flat = []
  for (const row of list ?? []) {
    const at = prefix === '' ? row.id : `${prefix}/${row.id}`
    flat.push({ at, row, group: row.group === true })
    if (row.group === true) flat.push(...flattenRows(row.config, at))
  }
  return flat
}

const dialect = loadLoaderDialect()
if (dialect.error !== undefined) {
  err(`[FAIL] 拿不到 loader 的 YAML 方言，无法交叉验证：${dialect.error}`)
  err('  loader 用 js-yaml + entryListSchema（带 !!js 标量类型）；')
  err('  没有它就查不出"转义后被改写"这一整类错误——那正是 v1.1.3 挂掉的原因。')
  process.exit(1)
}

let authoritative
try {
  authoritative = dialect.load(raw, { schema: dialect.schema })
} catch (error) {
  die(`loader 方言解析失败：${error.message}`)
}
if (!Array.isArray(authoritative)) {
  die('loader 方言解析出来的不是顶层列表——补丁文件必须是「一组补丁」的 YAML 数组')
}
notes.push('已用 loader 同款解析器（js-yaml + entryListSchema）交叉验证')

// 形状部分交给权威解析器判定：读不懂的形状在这里就停下来，后面的检查才有意义。
if (authoritative.length !== patchEntries.length) {
  die(`交叉验证：补丁条目数不一致（本脚本 ${patchEntries.length}，loader 方言 ${authoritative.length}）`)
}
const insertPatches = authoritative.filter((patch) => patch !== null && typeof patch === 'object' && 'insert' in patch)
if (insertPatches.length !== 1) {
  die(`补丁文件顶层应有且只有 1 条 insert 补丁，实际 ${insertPatches.length} 条——`
    + '本包只插自己那一行，不覆写别人的行（见文件头"注意：这一行可以被用户 patch 覆盖"）')
}
const inserted = insertPatches[0].insert
if (!Array.isArray(inserted)) die('insert 的值不是行列表')
if (inserted.length !== 1) die(`insert 应当只插 1 行（preset 声明行），实际 ${inserted.length} 行`)
const presetRow = inserted[0]
if (presetRow === null || typeof presetRow !== 'object' || Array.isArray(presetRow)) die('insert 里的 preset 行不是映射')
const presetPlugins = presetRow.config?.plugins
if (!Array.isArray(presetPlugins) || presetPlugins.length === 0) {
  die('preset 行的 config.plugins 不是非空行列表——模式的全部子插件都写在那里')
}
const localPreset = patchEntries[0]?.insert?.[0]
if (localPreset === undefined) die('本脚本的读取器没读出一条 insert 行（补丁形状变了）')

/**
 * 行的 `name` 必须是一个字符串。
 *
 * loader 只对 `config` 求值（`disabled` 单独走 `disabledOf`），**`name` 从不被插值**：
 * `name: !!js …` 会让这个字段变成一个 `{__jsExpr}` 对象，preset registry 的
 * `entryListProblem` 判它 "names no plugin"，整行不挂载——而报错信息离原因很远。
 */
function nameProblem(at, value) {
  return `行 ${at} 的 name 不是字符串（得到 ${JSON.stringify(value)?.slice(0, 80)}）——行的 name 永远不会被插值：`
    + 'loader 只对 config（与 disabled）求值，`name: !!js …` 只会把它变成对象，整行不挂载'
}

if (typeof presetRow.name !== 'string') die(nameProblem(presetRow.id ?? 'preset', presetRow.name))
if (localPreset.id !== presetRow.id || localPreset.name !== presetRow.name) {
  die(`交叉验证：preset 行的 id/name 两种解析不同（本脚本 ${JSON.stringify(localPreset.id)}/${JSON.stringify(localPreset.name)}，`
    + `loader 方言 ${JSON.stringify(presetRow.id)}/${JSON.stringify(presetRow.name)}）`)
}

const compositionRows = flattenRows(presetPlugins, '')
const localCompositionRows = flattenRows(localPreset.config?.plugins ?? [], '')
if (localCompositionRows.length !== compositionRows.length) {
  die(`交叉验证：子插件行数不一致（本脚本 ${localCompositionRows.length}，loader 方言 ${compositionRows.length}）`)
}

let compiledExpressions = 0
for (let index = 0; index < compositionRows.length; index += 1) {
  const mine = localCompositionRows[index]
  const theirs = compositionRows[index]
  if (mine.at !== theirs.at) {
    die(`交叉验证：第 ${index + 1} 条行的路径不同（本脚本 ${mine.at}，loader 方言 ${theirs.at}）`)
  }
  if (typeof theirs.row.name !== 'string') die(nameProblem(theirs.at, theirs.row.name))
  if (mine.row.name !== theirs.row.name) {
    die(`行 ${theirs.at} 的 name 两种解析不同（本脚本 ${JSON.stringify(mine.row.name)}，`
      + `loader 方言 ${JSON.stringify(theirs.row.name)}）`)
  }
  if (mine.group !== theirs.group) die(`行 ${theirs.at} 的 group 两种解析不同`)
  // 分组行的 `config` 是**子行列表**：它自己不带 config，子行各自负责自己的表达式。
  if (theirs.group) continue
  const left = jsExprs(mine.row.config ?? {})
  const right = jsExprs(theirs.row.config ?? {})
  if (left.length !== right.length) {
    die(`行 ${theirs.at} 的 !!js 数量不一致（本脚本 ${left.length}，loader 方言 ${right.length}）`)
  }
  for (let position = 0; position < left.length; position += 1) {
    if (left[position] !== right[position]) {
      err(`[FAIL] 行 ${theirs.at} 的第 ${position + 1} 个 !!js 两种解析结果不同——说明值里有 YAML 转义被改写了：`)
      err(`  本脚本（不做转义）：${JSON.stringify(left[position]).slice(0, 160)}`)
      err(`  loader 方言（真实）：${JSON.stringify(right[position]).slice(0, 160)}`)
      process.exit(1)
    }
  }
  // 真正那句：每个表达式都必须能编译。语法错误挂载时才炸，而那时 roster 里那一条直接 broken。
  for (const source of right) {
    try {
      compileExpression(source)
      compiledExpressions += 1
    } catch (error) {
      err(`[FAIL] 行 ${theirs.at} 的 !!js 编译不过：${error.message}`)
      err(`  源码：${JSON.stringify(source).slice(0, 200)}`)
      err('  提示：YAML 双引号标量会先处理 \\n \\t 这类转义；换行请用 String.fromCharCode(10)。')
      process.exit(1)
    }
  }
}

// 只编译还不够：要主动挡住"以后再被写回去"。`!!js` 双引号标量里的反斜杠会被 YAML
// 先吃掉（`\n` → 真换行），而**单引号或折叠标量里的反斜杠是字面量**、不危险。
// 所以只对双引号形式报警，并指明替代写法。
const riskyScalar = [...raw.matchAll(/!!js[ \t]+"([^"\n]*\\[^"\n]*)"/g)]
if (riskyScalar.length > 0) {
  for (const match of riskyScalar) {
    err(`[FAIL] !!js 双引号标量里出现反斜杠转义：${JSON.stringify(match[0]).slice(0, 160)}`)
  }
  err('  YAML 会先处理双引号标量里的 \\n \\t 等转义，JS 源码因此被改写甚至跨行。')
  err('  换行请写 String.fromCharCode(10)；需要字面反斜杠就用单引号或折叠标量（它们不处理转义）。')
  process.exit(1)
}

// ── 1d. 求值环境（临时目录 + junction）与每个 `!!js` 的求值 ──────────────────
//
// `!!js` 在**那一行加载时**求值，那一刻 `ctx.baseUrl` 是 profile 目录（不是包目录），
// 所以包内路径全是 `createRequire(baseUrl).resolve('dsh-story-mode/package.json')` 问出来的。
// 这里就把那个环境搭出来：临时目录 + `<临时目录>/node_modules/dsh-story-mode` 指向仓库根，
// 于是 baseUrl 指过去时 Node 能解析到本包——求值结果与真实挂载一致。
// 不搭这一步的话，所有包内路径都只会 MODULE_NOT_FOUND，而"persona 文件在不在"
// 这类问题就永远查不出来（脚本会变成只会说"通过"的橡皮图章）。
function makeEvaluationEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-story-mode-verify-'))
  const link = join(directory, 'node_modules', 'dsh-story-mode')
  mkdirSync(dirname(link), { recursive: true })
  try {
    // Windows 上 junction 不需要管理员权限或开发者模式；普通目录符号链接需要。
    symlinkSync(ROOT, link, 'junction')
  } catch (junctionError) {
    try {
      symlinkSync(ROOT, link, 'dir')
    } catch {
      die(`建不出求值环境（${link}）：${junctionError.message}——没有它就无法验证包内路径`)
    }
  }
  return {
    directory,
    link,
    // 尾分隔符不能少：少了 Node 会把 profile 目录当成一个**文件**，直接 MODULE_NOT_FOUND。
    baseUrl: pathToFileURL(directory + sep).href,
    dispose() {
      // Windows 上先摘链接再删目录：直接递归删会顺着链接走进仓库。
      try { unlinkSync(link) } catch { /* 已经不在了 */ }
      try { rmSync(directory, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }
    },
  }
}

const environment = makeEvaluationEnvironment()
process.on('exit', () => environment.dispose())
notes.push(`!!js 求值环境：baseUrl=${environment.baseUrl}（临时目录，退出时删除），`
  + 'dsh-story-mode 由其中的 node_modules 链接解析到包根')

/**
 * loader 自己的求值形式：`with (ctx) { return eval(expr) }`。
 *
 * 必须原样照抄——它是**非严格模式**下的直接 eval，所以表达式里的标识符先按 ctx 的属性
 * 解析（`baseUrl` 就是这么来的），`process` 之类的全局照常可见。写成 `return (expr)`
 * 或加上 `"use strict"` 都不是同一个语义（严格模式下 `with` 直接是语法错误）。
 */
const loaderEvaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
const evaluationContext = { baseUrl: environment.baseUrl }
let evaluatedExpressions = 0
function evaluateExpression(source) {
  evaluatedExpressions += 1
  return loaderEvaluate(evaluationContext, source)
}

function interpolate(value) {
  if (isJsExpr(value)) return evaluateExpression(value.__jsExpr)
  if (Array.isArray(value)) return value.map(interpolate)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item)
    return out
  }
  return value
}

// loader 只对 `config` 与 `disabled` 求值（`name` 永远不插值）。这一节把两者都跑一遍，
// 并顺带查"!!js 写在不会被求值的位置上"——那是 `name: !!js …` 那类错误的同一族。
const PRESET_AT = presetRow.id ?? 'preset'
const presetMetadataRaw = Object.fromEntries(
  Object.entries(presetRow.config ?? {}).filter(([key]) => key !== 'plugins'),
)
/** 一行自己负责求值的 `!!js`（与下面的求值循环一一对应）。 */
function ownExpressions(entry) {
  const found = []
  if (entry.isPreset === true) jsExprs(presetMetadataRaw, found)
  else if (entry.group !== true) jsExprs(entry.row.config ?? {}, found)
  if (isJsExpr(entry.row.disabled)) found.push(entry.row.disabled.__jsExpr)
  return found
}

const allRows = [{ at: PRESET_AT, row: presetRow, group: false, isPreset: true }, ...compositionRows]

for (const entry of allRows) {
  const stray = []
  for (const [key, value] of Object.entries(entry.row ?? {})) {
    if (key === 'config' || key === 'disabled') continue
    for (const source of jsExprs(value)) stray.push({ key, source })
  }
  if (stray.length > 0) {
    for (const { key, source } of stray) {
      err(`[FAIL] 行 ${entry.at} 的 ${key} 上有 !!js，但 loader 只对 config 与 disabled 求值：`)
      err(`  ${JSON.stringify(source).slice(0, 160)}`)
    }
    err('  它不会被求值，只会把那个字段变成一个 {__jsExpr} 对象——`name: !!js …` 就是这样让整行报错的。')
    process.exit(1)
  }
  if (entry.isPreset === true) {
    // preset 行的 config 是**载体**（`plugins` 是子行列表），loader 不整体插值它：
    // 子行的表达式由子行自己求值——所以这里只求 metadata，plugins 交给下面每一行。
    try {
      entry.resolvedConfig = interpolate(presetMetadataRaw)
    } catch (error) {
      fail(`行 ${entry.at} 的 !!js 求值失败：${error.message}`)
      entry.resolvedConfig = {}
    }
  } else if (entry.group) {
    entry.resolvedConfig = {}
  } else {
    try {
      entry.resolvedConfig = interpolate(entry.row.config ?? {})
    } catch (error) {
      fail(`行 ${entry.at} 的 !!js 求值失败：${error.message}`)
      entry.resolvedConfig = {}
    }
  }
  if (isJsExpr(entry.row.disabled)) {
    try {
      entry.disabledValue = Boolean(evaluateExpression(entry.row.disabled.__jsExpr))
    } catch (error) {
      fail(`行 ${entry.at} 的 disabled 表达式求值失败：${error.message}`)
    }
  }
}

const declaredExpressions = allRows.reduce((sum, entry) => sum + ownExpressions(entry).length, 0)
if (declaredExpressions !== compiledExpressions) {
  die(`!!js 数量对不上：交叉验证阶段编译了 ${compiledExpressions} 个，求值阶段应负责 ${declaredExpressions} 个`
    + '（可能写在分组行自己的 config 里，或者行数两种解析不同）')
}
if (evaluatedExpressions !== declaredExpressions) {
  die(`!!js 求值数量对不上：应当求值 ${declaredExpressions} 个，实际求值 ${evaluatedExpressions} 个——`
    + '说明有表达式被跳过了，脚本不能在这种情况下报"通过"')
}
notes.push(`共 ${compiledExpressions} 个 !!js：全部编译通过、逐字比对未被 YAML 改写，并在临时解析环境里求值`)

// ── 2. 组合形状 ─────────────────────────────────────────────────────────────
//
// 插进去的那一行是**预设声明**：id/name 决定它在 roster 里的身份，config.plugins 才是模式。
// 这几个字段错了不会报错，只会让模式换个名字、排到别处或者干脆空着——所以逐条钉住。
if (presetRow.id !== 'preset-short-story') {
  fail(`preset 行的 id 应为 preset-short-story（profile 的补丁按它覆写），实际 ${JSON.stringify(presetRow.id)}`)
}
if (presetRow.name !== '@deepseek-ai/dsh-agent-preset') {
  fail(`preset 行的 name 应为 @deepseek-ai/dsh-agent-preset，实际 ${JSON.stringify(presetRow.name)}`)
}
const presetConfig = { ...(allRows[0].resolvedConfig ?? {}), plugins: presetPlugins }
if (presetConfig.id !== 'short-story') {
  fail(`preset config.id 应为 short-story（会话日志与 skills 目录都按它索引），实际 ${JSON.stringify(presetConfig.id)}`)
}
if (typeof presetConfig.name !== 'string' || presetConfig.name.trim().length === 0) {
  fail(`preset config.name 是非空字符串（roster 里显示的名字），实际 ${JSON.stringify(presetConfig.name)}`)
}
if (typeof presetConfig.order !== 'number' || !Number.isFinite(presetConfig.order)) {
  fail(`preset config.order 必须是数字（官方预设占 1–4，本模式排在后面），实际 ${JSON.stringify(presetConfig.order)}`)
}
if (!Array.isArray(presetConfig.plugins) || presetConfig.plugins.length === 0) {
  fail('preset config.plugins 必须是非空行列表')
}
notes.push(`preset ${PRESET_AT} = ${JSON.stringify(presetConfig.id)}（${JSON.stringify(presetConfig.name)}，order ${JSON.stringify(presetConfig.order)}）：`
  + `子插件 ${presetPlugins.length} 行、摊平 ${compositionRows.length} 条（含分组行）`)
// preset 行也要过它自己的 schema（`plugins` 必填、config 里不该有拼错的键）：它校验的是
// metadata + **原始**子行列表——子行的 config 由子行各自负责。
allRows[0].schemaConfig = presetConfig

// ── 3. 每一行的 config 过插件自己的 schema ──────────────────────────────────
//
// 组合里写的字段名/类型与插件自己的 `Config` 不符时，loader 会在挂载那一刻拒绝整行；
// 表现同样是 preset broken。这里用 harness 里那个插件的真实 schema 逐行校验。
const packageEntry = (pkg) => {
  const root = pkg.exports?.['.']
  if (typeof root === 'string') return root
  if (root !== null && typeof root === 'object') {
    for (const key of ['default', 'import', 'require', 'node']) {
      if (typeof root[key] === 'string') return root[key]
    }
  }
  return typeof pkg.main === 'string' ? pkg.main : './lib/index.js'
}

let schemaChecked = 0
for (const entry of allRows) {
  if (entry.group) continue
  const name = entry.row.name
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/dsh-')) continue
  // 子路径行（`…/list-agents`）的 package.json 通常不在 exports 里；schema 校验
  // 只对整包行做，它们才是带 config 的那些。
  let entryPath
  try {
    entryPath = harnessRequire.resolve(`${name}/package.json`)
  } catch {
    continue
  }
  try {
    const pkg = JSON.parse(await readFile(entryPath, 'utf8'))
    const moduleUrl = new URL(packageEntry(pkg), pathToFileURL(entryPath))
    const mod = await import(moduleUrl.href)
    // 两种导出形态：命名导出 `Config`，或默认导出的插件类上的 `static Config`。
    // 漏掉后者会让 agent-preset / tool-result-pruner 这类行**静默跳过**校验。
    const schema = typeof mod.Config === 'function' ? mod.Config : mod.default?.Config
    if (typeof schema === 'function') {
      try {
        schema(entry.schemaConfig ?? entry.resolvedConfig ?? {})
        schemaChecked += 1
      } catch (error) {
        fail(`行 ${entry.at}（${name}）config 过不了插件自己的 schema：${error.message}`)
      }
    } else {
      notes.push(`行 ${entry.at}（${name}）没有导出 Config，跳过 schema 校验`)
    }
  } catch (error) {
    fail(`行 ${entry.at}（${name}）导入失败，无法校验：${error.message}`)
  }
}
// preset 行的 schemaConfig 在第 2 节就算好了（metadata + **原始**子行列表：子行的 config
// 由子行各自负责），所以上面这一圈已经把 preset 行一起校验过了。
notes.push(`config 过 schema：${schemaChecked} 行（用的是 harness 里那些插件自己的 Config）`)

// ── 4. 技能根与审读员人设文件 ───────────────────────────────────────────────
//
// 这两件事都是"路径只有运行时才算得出来"的：skill-filesystem 的 customSkillDirs 与每个
// 审读员行的 persona 都由 `!!js` 在挂载时求值。第 1d 节已经让它们真的跑过一遍，
// 这里只判断结果对不对——文件缺失会让那一行 config 无效、整个 preset 挂不上。
const skillRow = compositionRows.find((entry) => entry.at === 'skill-filesystem')
const skillDirs = skillRow?.resolvedConfig?.customSkillDirs
if (skillRow === undefined) {
  fail('组合里没有 id: skill-filesystem 的那一行——技能（含文风契约）不会挂进本模式')
} else if (!Array.isArray(skillDirs) || skillDirs.length === 0) {
  fail(`行 ${skillRow.at} 的 customSkillDirs 不是非空列表：${JSON.stringify(skillDirs)}`)
} else {
  const samePath = (left, right) => {
    const canonical = (value) => { try { return realpathSync(value) } catch { return resolve(value) } }
    const a = canonical(left)
    const b = canonical(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  if (!samePath(skillDirs[0], SKILLS_DIR)) {
    fail(`行 ${skillRow.at} 的 customSkillDirs[0] 没指到包内 skills/：${skillDirs[0]}（应为 ${SKILLS_DIR}）`)
  }
  for (const skill of ['short-story', 'writing-style-contract']) {
    const file = join(skillDirs[0], skill, 'SKILL.md')
    try {
      const text = await readFile(file, 'utf8')
      if (text.trim().length === 0) fail(`技能 ${skill}/SKILL.md 是空的：${file}`)
      else notes.push(`技能 ${skill}/SKILL.md：${text.length} 字符（由 customSkillDirs 指向）`)
    } catch (error) {
      fail(`技能 ${skill}/SKILL.md 读不到：${error.message}`)
    }
  }
}

const reviewers = compositionRows.filter((entry) => typeof entry.resolvedConfig?.toolName === 'string'
  && entry.resolvedConfig.toolName.startsWith('subagent_review_'))

// persona 必须**逐字**等于它自己那份角色文件；B4 还要多一段文风契约。
const contractFile = join(SKILLS_DIR, 'writing-style-contract', 'SKILL.md')
for (const entry of reviewers) {
  const { toolName, persona } = entry.resolvedConfig
  const file = ROLE_FILES[toolName]
  if (file === undefined) {
    fail(`行 ${entry.at} 的审读员工具名 ${toolName} 不在角色表里（应为 subagent_review_b1…b5）`)
    continue
  }
  const roleFile = join(REVIEWER_DIR, file)
  let roleText
  try {
    roleText = await readFile(roleFile, 'utf8')
  } catch (error) {
    fail(`行 ${entry.at}（${toolName}）的角色文件读不到：${error.message}`)
    continue
  }
  if (roleText.trim().length === 0) {
    fail(`行 ${entry.at}（${toolName}）的角色文件是空的：${roleFile}`)
    continue
  }
  if (typeof persona !== 'string' || persona.length === 0) {
    fail(`行 ${entry.at}（${toolName}）的 persona 没读出来（得到 ${JSON.stringify(persona)?.slice(0, 40)}）`)
    continue
  }
  if (toolName === 'subagent_review_b4') {
    // B4 的 persona = 角色说明 + 换行 + 文风契约全文。**顺序要紧**：契约的使用说明要求
    // "先读作者要求、再完整读正文、最后对照契约"，而 persona 在 system prompt 最前。
    let contractText
    try {
      contractText = await readFile(contractFile, 'utf8')
    } catch (error) {
      fail(`B4 的文风契约读不到：${error.message}`)
      continue
    }
    const expected = roleText + String.fromCharCode(10) + contractText
    if (persona !== expected) {
      if (persona === contractText + String.fromCharCode(10) + roleText) {
        fail(`B4 的 persona 把顺序拼反了：必须是**角色说明在前、文风契约在后**（${entry.at}）`)
      } else {
        fail(`B4 的 persona ≠ 角色文件 + 换行 + 文风契约全文（persona ${persona.length} 字符，应为 ${expected.length} 字符）`)
      }
    } else {
      notes.push(`  ${toolName}: persona ${persona.length} 字符 = ${file}（${roleText.length}）+ 换行 + `
        + `writing-style-contract/SKILL.md（${contractText.length}）`)
    }
    continue
  }
  if (persona !== roleText) {
    fail(`行 ${entry.at}（${toolName}）的 persona 与 ${file} 的内容不一致`
      + `（persona ${persona.length} 字符，文件 ${roleText.length} 字符）——人设必须逐字来自它自己那份文件`)
  } else {
    notes.push(`  ${toolName}: persona ${persona.length} 字符 = ${file}`)
  }
}

// ── 5. 工具名账本 ───────────────────────────────────────────────────────────

/** 从包的入口文件里抽出**候选**工具名；候选还要过 `packageDeclaresToolName` 才算数。 */
async function toolNamesFromPackage(packageName) {
  const entryPath = harnessRequire.resolve(`${packageName}/package.json`)
  const pkg = JSON.parse(await readFile(entryPath, 'utf8'))
  const modulePath = fileURLToPath(new URL(packageEntry(pkg), pathToFileURL(entryPath)))
  const source = await readFile(modulePath, 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)) names.add(match[1])
  return names
}

/**
 * 某个包（含它的子路径入口）里是否真的注册过这个工具名。
 *
 * `list_agents` 住在 `…/list-agents` 子路径入口里，只扫主入口会漏掉它——而
 * `tools.restrict()` 对未知名字抛错，漏掉的后果是"脚本说安全、派发却直接失败"。
 */
async function packageDeclaresToolName(packageName, toolName) {
  const entryPath = harnessRequire.resolve(`${packageName}/package.json`)
  const pkg = JSON.parse(await readFile(entryPath, 'utf8'))
  const directory = dirname(entryPath)
  const files = new Set()
  const addFile = (absolute) => { if (absolute.endsWith('.js')) files.add(absolute) }
  const fromSpecifier = (specifier) => {
    try {
      addFile(harnessRequire.resolve(specifier))
    } catch { /* 子路径可能不是文件导出，忽略 */ }
  }
  addFile(join(directory, 'lib', 'index.js'))
  for (const subpath of Object.keys(pkg.exports ?? {})) {
    if (subpath === '.') continue
    if (typeof pkg.exports[subpath] === 'string') fromSpecifier(`${packageName}/${subpath.replace(/^\.\//, '')}`)
  }
  try {
    const lib = join(directory, 'lib')
    for (const name of await readdir(lib)) {
      if (name.endsWith('.js')) files.add(join(lib, name))
      if (name === 'types') {
        for (const nested of await readdir(join(lib, 'types'))) {
          if (nested.endsWith('.js')) files.add(join(lib, 'types', nested))
        }
      }
    }
  } catch { /* 包布局不同就以已收集的文件为准 */ }
  const needle = new RegExp(`\\bname:\\s*["']${toolName}["']`)
  for (const file of files) {
    try {
      if (needle.test(await readFile(file, 'utf8'))) return true
    } catch { /* 读不到就换下一个 */ }
  }
  return false
}

const TOOL_ROWS = compositionRows.filter((entry) => typeof entry.row.name === 'string'
  && entry.row.name.startsWith('@deepseek-ai/dsh-tool-'))
const toolLedger = new Set()

for (const entry of TOOL_ROWS) {
  const packageName = entry.row.name.split('/').slice(0, 2).join('/')
  const config = entry.resolvedConfig ?? {}
  // 只检查**名字字段**：`provider: spawn`、`backgroundMode: continuable` 里的
  // 裸词恰好也是小写标识符，不排除掉就会把它们算成工具名。
  const candidates = []
  const add = (value) => { if (typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value)) candidates.push(value) }
  // config 里显式给的工具名由构造保证会被注册（插件就按它注册）；源码里抽出来的
  // 候选必须先确认真的注册过——源码正文里出现一个词不等于它是一个工具。
  const configDeclared = typeof config.toolName === 'string' ? config.toolName : null
  if (configDeclared !== null) add(configDeclared)
  if (packageName.endsWith('subagent-control')) { add('send_message'); add('interrupt_agent'); add('list_agents') }
  if (!packageName.endsWith('tool-subagent')) {
    for (const name of await toolNamesFromPackage(packageName)) add(name)
  }
  const declared = []
  for (const name of [...new Set(candidates)]) {
    if (name === configDeclared || await packageDeclaresToolName(packageName, name)) declared.push(name)
  }
  for (const name of declared) toolLedger.add(name)
  notes.push(`工具行 ${entry.at}：${declared.length > 0 ? declared.join(', ') : '**没确认到任何工具名**'}`)
  if (declared.length === 0) fail(`行 ${entry.at}（${entry.row.name}）没能确认它注册的工具名，本脚本无法判断 toolFilter 是否安全`)
}

if (!toolLedger.has('read') || !toolLedger.has('write')) {
  die('工具账本没确认到 fs 的 read/write，本脚本无法判断 toolFilter 的名字是否正确')
}
notes.push(`工具账本共 ${toolLedger.size} 个名字（每个都确认过注册在它那一行所属的包里）`)

const seenTool = new Set()
for (const entry of compositionRows) {
  const name = entry.resolvedConfig?.toolName
  if (typeof name !== 'string') continue
  if (seenTool.has(name)) fail(`工具名重复：${name}（两行会抢同一个名字）`)
  seenTool.add(name)
}

// ── 6. toolFilter 只能点名"本组合真正注册过"的工具 ──────────────────────────
//
// `tools.restrict()` 对**未知**工具名抛错（allow 与 deny 都查，源码里
// `[...allow ?? [], ...deny ?? []].filter(name => !known.has(name))`），而它抛在子代理的
// 创建窗口里——那次派发直接失败。所以这里只能证明两件事：名字在它所属的包里被注册过，
// 且那个包有一行在本组合里。剩下的一小步（该行在会话里真的激活了）只能靠真实会话来确认。
for (const entry of compositionRows) {
  const filter = entry.resolvedConfig?.toolFilter
  if (filter === undefined) continue
  for (const kind of ['allow', 'deny']) {
    for (const name of filter[kind] ?? []) {
      if (!toolLedger.has(name)) {
        fail(`行 ${entry.at} 的 toolFilter.${kind} 点名了本组合不提供的工具 "${name}"——`
          + '若它也不在全局层，tools.restrict() 会在子代理创建时抛错，那次派发会直接失败')
      }
    }
  }
}

// ── 7. 审读员：可复用、只读、各有专用工具名 ─────────────────────────────────
//
// 只读判定**不能只看 allow**：`allow` 缩小可见集合，`deny` 再减一次。所以这里
// 同时要求两个方向都对——放行的每一项都在只读白名单里，写入与再委派工具被显式拒掉。
const BANNED = ['write', 'edit', 'present', 'subagent', 'send_message', 'interrupt_agent', 'list_agents']
const READ_ONLY_ALLOW = new Set(['read', 'read_image', 'str_replace_editor', 'glob', 'grep'])
const REVIEWER_TOOL_NAMES = ['subagent_review_b1', 'subagent_review_b2', 'subagent_review_b3', 'subagent_review_b4', 'subagent_review_b5']

if (reviewers.length !== 5) fail(`审读员行应有 5 个，实际 ${reviewers.length} 个`)
for (const toolName of REVIEWER_TOOL_NAMES) {
  if (!reviewers.some((entry) => entry.resolvedConfig.toolName === toolName)) {
    fail(`缺少审读员行 ${toolName}——面板里的角色表点了名，而它没有自己的工具`)
  }
}

for (const entry of reviewers) {
  const { toolName, toolFilter, backgroundMode, provider } = entry.resolvedConfig
  // 可复用模式（continuable）下才调用 `subagents.startContinuable()`，才拿得到持久 childId；
  // one-shot 是"派一次、从头读一遍、报完就没了"，改稿后的复核只能再派一位全新读者。
  if (backgroundMode !== 'continuable') {
    fail(`行 ${entry.at}（${toolName}）的 backgroundMode 是 ${JSON.stringify(backgroundMode)}，审读员必须是 continuable——`
      + '否则改稿复核拿不到 childId，只能每次重派一位冷读者')
  }
  if (provider !== 'spawn') {
    fail(`行 ${entry.at}（${toolName}）的 provider 是 ${JSON.stringify(provider)}，应为 spawn`)
  }
  if (toolFilter === undefined) {
    fail(`行 ${entry.at}（${toolName}）没有 toolFilter——只读会退回成提示词约束`)
    continue
  }
  const allowed = toolFilter.allow ?? []
  const denied = toolFilter.deny ?? []
  if (allowed.length === 0) fail(`行 ${entry.at}（${toolName}）的 toolFilter.allow 是空的`)
  for (const name of allowed) {
    if (!READ_ONLY_ALLOW.has(name)) fail(`行 ${entry.at}（${toolName}）放行了非只读工具 "${name}"`)
  }
  for (const name of BANNED) {
    if (allowed.includes(name)) fail(`行 ${entry.at}（${toolName}）把 "${name}" 放进了 allow`)
    if (!denied.includes(name)) fail(`行 ${entry.at}（${toolName}）没有显式 deny "${name}"`)
  }
  if (allowed.includes('skill')) fail(`行 ${entry.at}（${toolName}）允许了 skill；契约应拼进 B4 的 persona，其余角色不该读技能`)
}

// 委派链路的两个前提：命名工具与子路径行都在组合里，且这个模式刻意不开 fork
// （fork 会把主代理的大纲与写作推理一起复制给读者，审读独立性立刻消失）。
for (const required of ['@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-subagent-control/list-agents']) {
  if (!compositionRows.some((entry) => entry.row.name === required)) {
    fail(`组合里没有 ${required} 那一行——send_message / list_agents 少一个，审读员就复用不起来`)
  }
}
for (const entry of compositionRows) {
  if (entry.resolvedConfig?.provider === 'fork') {
    fail(`行 ${entry.at} 用了 provider: fork——fork 继承主代理的全部上下文，读者看过底牌就不再是读者证据`)
  }
}
if (reviewers.length > 0) {
  notes.push(`审读员 ${reviewers.length} 行：backgroundMode=continuable、provider=spawn、只看不写、`
    + 'allow 只列读类工具、deny 拿掉写入与再委派')
}

// ── 8. 静态形状与可移植性 ───────────────────────────────────────────────────
//
// 这一节查的都是"改错了要到别的机器上才发作"的东西：行的 name 永不被插值、包内路径
// 不能写死成本机绝对路径、插进去的行只能是 loader 认得的 key。
//
// 关键约束（都是从 loader 源码里读出来的，见补丁文件头）：
//   * **行的 `name` 永远不会被插值**，loader 只对 `config` 调 `interpolate()`，
//     `disabled` 单独走 `disabledOf`。所以子行的 `name: !!js …` 会变成对象、整行报错。
//   * 子行的解析基准是 **profile 目录**，不是包目录。本包自己的插件行只能写裸包名
//     `dsh-story-mode`（profile 的 node_modules 里就是它）；相对路径与 file:// 都会钉死安装位置。
// 补丁只允许 `insert`：loader 认得的补丁 key 还有 id/name/config/group/disabled/inject/
// isolate，但**本包一个都不该用**——覆写别人的行就是和官方抢同一行，官方加字段就会被静默
// 抹掉（这正是 0.1.7 之前那版补丁的代价，见补丁文件头）。真要放开，先在这里写下理由。
const ALLOWED_PATCH_KEYS = new Set(['insert'])
// 行 key 就是 loader 的 `EntryOptions`（isolate 是它模块增强出来的那一个，本组合的分组行在用）。
const ALLOWED_ROW_KEYS = new Set(['id', 'name', 'config', 'group', 'disabled', 'inject', 'isolate'])

for (const patch of authoritative) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    fail(`补丁条目不是映射：${JSON.stringify(patch)?.slice(0, 60)}`)
    continue
  }
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      fail(`补丁条目里有不认识的 key "${key}"——本包只插自己那一行；覆写别人的行会和官方抢行`
        + '（官方加字段就被静默抹掉），真要那么做先在这里把理由写清楚')
    }
  }
}
for (const entry of allRows) {
  for (const key of Object.keys(entry.row ?? {})) {
    if (!ALLOWED_ROW_KEYS.has(key)) {
      fail(`行 ${entry.at} 里有 loader 不认得的 key "${key}"——loader 会原样收下它（不报错也不生效），`
        + '所以在这里拦住')
    }
  }
  if (typeof entry.row?.name !== 'string') {
    fail(`行 ${entry.at} 的 name 不是字符串（${JSON.stringify(entry.row?.name)?.slice(0, 60)}）——行的 name 从不被插值`)
  } else if (entry.row.name.startsWith('.') || entry.row.name.startsWith('/') || entry.row.name.includes(':')) {
    // `cordis:group` 这类内置名字除外（它由 loader 的 builtins 提供）。
    if (!entry.row.name.startsWith('cordis:')) {
      fail(`行 ${entry.at} 的 name "${entry.row.name}" 是相对/绝对路径或 URL——`
        + 'config.plugins 里的名字按 profile 目录解析，只有裸包名才稳（见补丁文件头第 2 条）')
    }
  }
}
// `name: !!js …` 在权威解析后已经不是字符串（上面那条会报），这里再按原文拦一次：
// 它会先把值变成对象，报错信息离原因很远。
if (/^[ \t]*name:[ \t]*!!js/m.test(raw)) {
  die('行的 name 上写了 !!js——loader 只对 config 与 disabled 求值，name 从不被插值')
}

const ownRow = compositionRows.find((entry) => entry.at === 'story-tools')
if (ownRow === undefined) {
  fail('组合里没有 id: story-tools 的那一行——本包自己的插件（story_wordcount / story_lint 等）没被插进去')
} else if (ownRow.row.name !== 'dsh-story-mode') {
  fail(`id: story-tools 的 name 必须是**裸包名** dsh-story-mode（profile 的 node_modules 里就是它），`
    + `实际 ${JSON.stringify(ownRow.row.name)}`)
}

if (/[A-Za-z]:\\/.test(raw)) {
  fail('补丁里出现了机器相关的 Windows 绝对路径（[A-Za-z]:\\）——包内路径只能在运行时用 createRequire(baseUrl) 问出来')
}
if (/file:\/\//.test(raw)) {
  fail('补丁里出现了 file:// URL——安装位置在发布时不可能知道，写死会让这个补丁在别的机器上指向不存在的文件')
}

const ownEntry = join(ROOT, 'lib', 'index.js')
if (!existsSync(ownEntry)) {
  fail(`lib/index.js 不存在（${ownEntry}）——story-tools 那一行会加载失败`)
} else {
  try {
    const module = await import(pathToFileURL(ownEntry).href)
    if (typeof module.apply !== 'function') fail('lib/index.js 没有导出 apply——loader 会把它当成无效插件')
  } catch (error) {
    fail(`lib/index.js 导入失败：${error.message}`)
  }
}

// 技能文档里的两条契约（只查最便宜、最容易在改稿时被删掉的两句）：
// 派发一律走后台、改稿复核用 send_message 发回同一位读者。删掉它们，可复用就只是配置。
const entrySkill = join(SKILLS_DIR, 'short-story', 'SKILL.md')
try {
  const text = await readFile(entrySkill, 'utf8')
  if (!text.includes('send_message')) fail('skills/short-story/SKILL.md 没提 send_message——改稿复核要靠它发回同一位读者')
  if (!text.includes('run_in_background: false')) {
    fail('skills/short-story/SKILL.md 没有 `run_in_background: false` 的警告——前台调用拿不到可复用的 childId')
  }
} catch (error) {
  fail(`skills/short-story/SKILL.md 读不到：${error.message}`)
}
notes.push('静态形状：行名全是包标识符、包内路径无绝对路径与 file://、patch/行 key 在 loader 认得的集合里')

// ── 输出 ────────────────────────────────────────────────────────────────────

out('# 组合自检')
out('')
for (const note of notes) out(`- ${note}`)
out('')
if (failures.length === 0) {
  out('全部通过：补丁形状正确、每个 !!js 可编译且未被 YAML 转义改写、每行 config 过插件自己的 schema、'
    + '包内路径在临时解析环境里真的求得出来、toolFilter 只点名真实工具、审读员均可复用且只读。')
  process.exit(0)
}
err(`有 ${failures.length} 项失败：`)
for (const failure of failures) err(`  - ${failure}`)
process.exit(1)
