/**
 * 组合自检：把 preset 的 agent.cordis.yml 当成 loader 那样读一遍。
 *
 * 它回答的不是"文件能不能解析"，而是四个**只在装配时才会暴露**的问题：
 *   1. 每行的 `!!js` 能不能求值——尤其是审读员行的 persona 真能从包内文件读出来；
 *   2. 每行的 `config` 能不能过插件自己的 Config schema；
 *   3. `toolFilter` 里点名的工具是不是本组合真实注册过的（名字错了会在子代理
 *      创建窗口抛错＝那次派发直接失败）；
 *   4. 审读员有没有被误授权写文件、呈现或再委派，以及有没有重复的工具名。
 *
 * 用法：node scripts/verify-composition.mjs
 * 退出码 0 = 全过；1 = 有失败项（打印到 stderr）。
 *
 * **零依赖**（和这个包本身一样）：这里的 YAML 读取器只认本组合实际用到的子集
 * ——顶层/分组的块序列、`key: value` 映射、`|-` 字面块标量、`- 值` 标量序列、
 * `[...]` 流序列、`#` 注释和 `!!js` 标量标记。它是**校验器**，不是通用解析器：
 * 遇到不认识的形状会直接报错退出，而不是猜。这样"脚本读错了组合"永远不会伪装成
 * "组合是对的"。
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const COMPOSITION = join(ROOT, 'presets', 'short-story', 'agent.cordis.yml')
const baseUrl = pathToFileURL(join(ROOT, 'presets', 'short-story') + '\\').href

const failures = []
const notes = []
const fail = (message) => failures.push(message)

/** 审读员工具名 → 它的固定人设文件；组合里每一行都按这张表读文件。 */
const ROLE_FILES = {
  subagent_review_b1: 'b1-cold-read.md',
  subagent_review_b2: 'b2-story-logic.md',
  subagent_review_b3: 'b3-reading-experience.md',
  subagent_review_b4: 'b4-style-execution.md',
  subagent_review_b5: 'b5-physical-continuity.md',
}

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

/** 读取 `|-` / `>-` 之类的块标量，返回 [文本, 下一个行号]。 */
function readBlockScalar(lines, index, cursor, folded) {
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
  return [folded ? collected.join(' ').trim() : collected.join('\n'), index]
}

/** 已读到的插件行数与标量序列项数——两者用途不同，分开记。 */
let pluginRowsRead = 0
let scalarItemsRead = 0

/**
 * 已经消费到的最远行号。
 *
 * 这个读取器只认组合实际用到的 YAML 子集，所以"少读/重复读一行"是它最危险的
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

/** 读取块序列。`mode: 'rows'` 是插件行，`mode: 'scalars'` 是 `- 值` 形式的标量序列。 */
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
        const look = index + 1
        if (look < lines.length && lines[look].trim() !== '') {
          const childIndent = lines[look].length - lines[look].trimStart().length
          if (childIndent > cursor) {
            const childLine = stripComment(lines[look].slice(childIndent))
            // `- 值`（没有 `key:`）是标量序列；`- id: …` 才是插件行。
            const childMode = childLine.startsWith('- ') && !/^-\s+[\w-]+\s*:/.test(childLine) ? 'scalars' : 'rows'
            const [nested, next] = childLine.startsWith('- ')
              ? parseRows(lines, look, childIndent, childMode)
              : parseMapping(lines, look, childIndent)
            row[key] = nested
            index = Math.max(next - 1, index)
            if (index < look) index = look
            continue
          }
        }
        row[key] = ''
        continue
      }
      row[key] = parseScalar(rest, `第 ${index + 1} 行`)
    }
    // 组合的每一行都必须有 id：没有 id 的条目只能是嵌套序列（例如 customSkillDirs），
    // 把它当成行会让"行数对不对"的检查失去意义，所以这里直接失败。
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new YamlSubsetError(`第 ${index + 1} 行附近：缩进 ${indent} 的条目没有 id，说明读取器把嵌套序列当成了插件行`)
    }
    rows.push(row)
    pluginRowsRead += 1
    if (process.env.VERIFY_TRACE === '1') console.error(`  [row ${pluginRowsRead}] line ${index + 1} id=${row.id}`)
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
      const look = index + 1
      if (look < lines.length && lines[look].trim() !== '') {
        const childIndent = lines[look].length - lines[look].trimStart().length
        if (childIndent > indent) {
          const childLine = stripComment(lines[look].slice(childIndent))
          const childMode = childLine.startsWith('- ') && !/^-\s+[\w-]+\s*:/.test(childLine) ? 'scalars' : 'rows'
          const [nested, next] = childLine.startsWith('- ')
            ? parseRows(lines, look, childIndent, childMode)
            : parseMapping(lines, look, childIndent)
          map[key] = nested
          // 永远向前走：嵌套解析器在原地返回时，至少跨过刚看的那一行。
          index = Math.max(next, look + 1)
          continue
        }
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

function parseComposition(text) {
  return parseRows(text.replace(/^\uFEFF/, '').split(/\r?\n/), 0, 0)[0]
}

// ── 求值环境（与 loader 给 `!!js` 的一致：`ctx.baseUrl` + process 全局）──────

function interpolate(value) {
  if (value instanceof Object && '__jsExpr' in value) return evaluate(value.__jsExpr)
  if (Array.isArray(value)) return value.map(interpolate)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item)
    return out
  }
  return value
}

function evaluate(source) {
  // `baseUrl` 走参数而不是外层作用域：严格模式下的 `new Function` 不会闭包捕获
  // 模块作用域的绑定，写成自由变量会直接 ReferenceError。
  const factory = new Function('ctx', 'baseUrl', 'process', `"use strict"; return (${source});`)
  return factory({ baseUrl }, baseUrl, process)
}

// ── 1. 读并解析 ─────────────────────────────────────────────────────────────

const raw = await readFile(COMPOSITION, 'utf8')
let rows
try {
  rows = parseComposition(raw)
} catch (error) {
  console.error(`[FAIL] 组合读不动：${error.message}`)
  process.exit(1)
}
// 读取器只认子集；形状对不上时必须响亮地失败，而不是少读几行之后报"通过"。
// 计数用 `[ \t]*` 而不是 `\s*`：多行模式下 `\s` 会跨行吞掉换行，把 25 条读成 0 条。
const declaredRows = (raw.match(/^[ \t]*- id:/gm) ?? []).length
if (declaredRows !== pluginRowsRead) {
  console.error(`[FAIL] YAML 读取器读到的行数与文件不符：文件里 ${declaredRows} 个 "- id:"，读出 ${pluginRowsRead} 个`)
  process.exit(1)
}

const flat = []
function walk(list, prefix) {
  for (const row of list) {
    const at = prefix === '' ? row.id : `${prefix}/${row.id}`
    if (row.group === true) {
      walk(row.config ?? [], at)
      continue
    }
    flat.push({ ...row, at })
  }
}
walk(rows, '')

notes.push(`组合 ${pluginRowsRead} 行（含分组子行），其中子代理工具 ${flat.filter((r) => String(r.name).includes('tool-subagent')).length} 行；另有标量序列项 ${scalarItemsRead} 个`)

// ── 2. 每行的 !!js 与 config schema ────────────────────────────────────────

/**
 * 找 `@deepseek-ai/*` 的地方。
 *
 * 本包**没有依赖**（连 schemastery 都不 import），所以仓库里没有 node_modules 可查；
 * 而那些插件装在 harness 自己的 node_modules 下。顺序是：脚本自己解析得到的位置
 * → `DSH_HARNESS` → 桌面版的默认路径。**找不到就报错，不静默降级**：这个脚本的
 * 另一半价值就是"工具名对不对"，账本读不到时它必须说自己不可信。
 */
function resolveHarnessRequire() {
  const candidates = []
  try {
    // 在 harness 自己启动的进程里（或装了 workspace 链接时），这一条就能命中。
    const here = createRequire(import.meta.url)
    here.resolve('@deepseek-ai/dsh-tool-fs/package.json')
    candidates.push({ require: here, label: '脚本自身的解析路径' })
  } catch { /* 仓库里没有 node_modules，正常 */ }
  const explicit = process.env.DSH_HARNESS
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    candidates.push({ require: createRequire(new URL('file:///' + explicit.replace(/\\/g, '/').replace(/\/?$/, '/') + 'package.json')), label: `DSH_HARNESS=${explicit}` })
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
  console.error('[FAIL] 找不到 harness 的 node_modules，无法读取插件源码与 Config schema。')
  console.error('  这个脚本要验证 toolFilter 里的工具名和每行 config，必须能查到已安装的插件。')
  console.error('  用 DSH_HARNESS=<harness 安装目录> 指给它，例如：')
  console.error('    $env:DSH_HARNESS = "C:\\Program Files\\DSH Desktop\\resources\\app"')
  console.error(`  试过的位置：${harness.candidates.map((c) => c.label).join('、')}`)
  process.exit(1)
}
const harnessRequire = harness.found[0].require
notes.push(`插件源码来自：${harness.found[0].label}${harness.found.length > 1 ? `（另有 ${harness.found.length - 1} 处同样可用）` : ''}`)

const SUBAGENT_TOOL_NAMES = new Set()

for (const row of flat) {
  let config
  try {
    config = interpolate(row.config ?? {})
  } catch (error) {
    fail(`行 ${row.at} 的 !!js 求值失败：${error.message}`)
    row.resolvedConfig = {}
    continue
  }
  row.resolvedConfig = config
  if (typeof config.toolName === 'string') SUBAGENT_TOOL_NAMES.add(config.toolName)

  if (typeof row.name !== 'string' || !row.name.startsWith('@deepseek-ai/dsh-')) continue
  // 子路径行（`…/list-agents`）的 package.json 通常不在 exports 里；schema 校验
  // 只对整包行做，它们才是带 config 的那些。
  let entry
  try {
    entry = harnessRequire.resolve(`${row.name}/package.json`)
  } catch {
    continue
  }
  try {
    const pkg = JSON.parse(await readFile(entry, 'utf8'))
    const main = pkg.exports?.['.'] ?? pkg.main ?? './lib/index.js'
    const moduleUrl = new URL(typeof main === 'string' ? main : './lib/index.js', pathToFileURL(entry))
    const mod = await import(moduleUrl.href)
    if (typeof mod.Config === 'function') {
      try {
        mod.Config(config)
      } catch (error) {
        fail(`行 ${row.at}（${row.name}）config 过不了插件自己的 schema：${error.message}`)
      }
    } else {
      notes.push(`行 ${row.at}（${row.name}）没有导出 Config，跳过 schema 校验`)
    }
  } catch (error) {
    fail(`行 ${row.at}（${row.name}）导入失败，无法校验：${error.message}`)
  }
}

// ── 3. 工具名账本 ───────────────────────────────────────────────────────────

/** 从包的入口文件里抽出**候选**工具名；候选还要过 `packageDeclaresToolName` 才算数。 */
async function toolNamesFromPackage(packageName) {
  const entry = harnessRequire.resolve(`${packageName}/package.json`)
  const pkg = JSON.parse(await readFile(entry, 'utf8'))
  const main = pkg.exports?.['.'] ?? pkg.main ?? './lib/index.js'
  const modulePath = fileURLToPath(new URL(typeof main === 'string' ? main : './lib/index.js', pathToFileURL(entry)))
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
  const entry = harnessRequire.resolve(`${packageName}/package.json`)
  const pkg = JSON.parse(await readFile(entry, 'utf8'))
  const directory = dirname(entry)
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
    const target = pkg.exports[subpath]
    if (typeof target === 'string') fromSpecifier(`${packageName}/${subpath.replace(/^\.\//, '')}`)
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

const TOOL_ROWS = flat.filter((row) => typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/dsh-tool-'))
const toolRowTools = new Map()
const toolLedger = new Set()

for (const row of TOOL_ROWS) {
  const packageName = row.name.split('/').slice(0, 2).join('/')
  const config = row.resolvedConfig ?? {}
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
  toolRowTools.set(row.at, declared)
  for (const name of declared) toolLedger.add(name)
  notes.push(`工具行 ${row.at}：${declared.length > 0 ? declared.join(', ') : '**没确认到任何工具名**'}`)
  if (declared.length === 0) fail(`行 ${row.at}（${row.name}）没能确认它注册的工具名，本脚本无法判断 toolFilter 是否安全`)
}

if (!toolLedger.has('read') || !toolLedger.has('write')) {
  console.error('[FAIL] 工具账本没确认到 fs 的 read/write，本脚本无法判断 toolFilter 的名字是否正确')
  process.exit(1)
}
notes.push(`工具账本共 ${toolLedger.size} 个名字（每个都确认过注册在它那一行所属的包里）`)

const seenTool = new Set()
for (const row of flat) {
  const name = row.resolvedConfig?.toolName
  if (typeof name !== 'string') continue
  if (seenTool.has(name)) fail(`工具名重复：${name}（两行会抢同一个名字）`)
  seenTool.add(name)
}

// ── 4. toolFilter 只能点名"本组合真正注册过"的工具 ──────────────────────────
//
// `tools.restrict()` 对未知工具名**抛错**，而它抛在子代理的创建窗口里——那次派发
// 直接失败。所以这里只能证明两件事：名字在它所属的包里被注册过，且那个包有一行
// 在本组合里。剩下的一小步（该行在会话里真的激活了）只能靠真实会话来确认。
for (const row of flat) {
  const filter = row.resolvedConfig?.toolFilter
  if (filter === undefined) continue
  for (const kind of ['allow', 'deny']) {
    for (const name of filter[kind] ?? []) {
      if (!toolLedger.has(name)) {
        fail(`行 ${row.at} 的 toolFilter.${kind} 点名了本组合不提供的工具 "${name}"——若它也不在全局层，tools.restrict() 会在子代理创建时抛错，那次派发会直接失败`)
      }
    }
  }
}

// ── 5. 审读员不得被授权写、呈现或再委派 ────────────────────────────────────
//
// 只读判定**不能只看 allow**：`allow` 缩小可见集合，`deny` 再减一次。所以这里
// 同时要求两个方向都对——放行的每一项都在只读白名单里，写入与再委派工具被显式拒掉。
const BANNED = ['write', 'edit', 'present', 'subagent', 'send_message', 'interrupt_agent', 'list_agents']
const READ_ONLY_ALLOW = new Set(['read', 'read_image', 'str_replace_editor', 'glob', 'grep'])
const reviewers = flat.filter((row) => typeof row.resolvedConfig?.toolName === 'string'
  && row.resolvedConfig.toolName.startsWith('subagent_review_'))

if (reviewers.length !== 5) fail(`审读员行应有 5 个，实际 ${reviewers.length} 个`)

for (const row of reviewers) {
  const { toolName, toolFilter, persona } = row.resolvedConfig
  if (toolFilter === undefined) {
    fail(`行 ${row.at}（${toolName}）没有 toolFilter——只读会退回成提示词约束`)
    continue
  }
  const allowed = toolFilter.allow ?? []
  const denied = toolFilter.deny ?? []
  for (const name of allowed) {
    if (!READ_ONLY_ALLOW.has(name)) fail(`行 ${row.at}（${toolName}）放行了非只读工具 "${name}"`)
  }
  for (const name of BANNED) {
    if (allowed.includes(name)) fail(`行 ${row.at}（${toolName}）把 "${name}" 放进了 allow`)
    if (!denied.includes(name)) fail(`行 ${row.at}（${toolName}）没有显式 deny "${name}"`)
  }
  if (allowed.includes('skill')) fail(`行 ${row.at}（${toolName}）允许了 skill；契约应拼进 B4 的 persona，其余角色不该读技能`)
  if (typeof persona !== 'string' || persona.trim().length < 200) {
    fail(`行 ${row.at}（${toolName}）的 persona 没读出来（得到 ${JSON.stringify(persona)?.slice(0, 40)}）`)
    continue
  }
  // persona 必须真的来自角色文件：首行与文件首行逐字比对。
  const roleFile = join(ROOT, 'presets', 'short-story', 'skills', 'short-story', 'references', 'reviewers', ROLE_FILES[toolName])
  const roleText = await readFile(roleFile, 'utf8')
  const roleFirstLine = roleText.trim().split('\n')[0].trim()
  if (!persona.startsWith(roleFirstLine)) {
    fail(`行 ${row.at}（${toolName}）的 persona 不是从 ${ROLE_FILES[toolName]} 读出来的（首行不符）`)
  }
  notes.push(`  ${toolName}: persona ${persona.length} 字符 = ${ROLE_FILES[toolName]}（${roleText.length}）+ ${persona.length - roleText.length} 附加`)
}

// ── 6. B4 必须带着文风契约全文 ──────────────────────────────────────────────

const b4 = reviewers.find((row) => row.resolvedConfig.toolName === 'subagent_review_b4')
if (b4 !== undefined) {
  const persona = b4.resolvedConfig.persona ?? ''
  const contract = await readFile(join(ROOT, 'skills', 'writing-style-contract', 'SKILL.md'), 'utf8')
  // 契约正文里的第一句实质内容必须原样出现在 persona 里——只比长度会被"读了另一个文件"骗过。
  const probe = contract.split('\n').find((line) => line.trim().length > 20 && !line.startsWith('---'))?.trim()
  if (probe === undefined || !persona.includes(probe)) {
    fail(`B4 的 persona 里找不到文风契约的正文（探测句：${JSON.stringify(probe?.slice(0, 30))}）`)
  }
  const expected = (await readFile(join(ROOT, 'presets', 'short-story', 'skills', 'short-story', 'references', 'reviewers', ROLE_FILES.subagent_review_b4), 'utf8')).length + 1 + contract.length
  if (Math.abs(persona.length - expected) > 4) {
    fail(`B4 的 persona 长度 ${persona.length} 与"角色文件 + 契约"（${expected}）不符`)
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────

console.log('# 组合自检')
console.log('')
for (const note of notes) console.log(`- ${note}`)
console.log('')
if (failures.length === 0) {
  console.log('全部通过：每行的 !!js 可求值、config 过 schema、toolFilter 只点名真实工具、审读员均为只读。')
  process.exit(0)
}
console.error(`有 ${failures.length} 项失败：`)
for (const failure of failures) console.error(`  - ${failure}`)
process.exit(1)
