/**
 * DSH 小说模式的只读工具，零运行时依赖。
 * 路径与读取通过宿主 fs；写入仍由常规文件工具负责。
 * 字数、分场、配额和字段检查是程序事实；用词命中仅供审读定位。
 * 视角、时态、人物动机、因果、节奏与文风需要上下文判断。
 * 模式与技能住在包内，安装/加载约束见 README 与 cordis.patch.yml。
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { doctorTool } from './doctor.js'
import { makeTool } from './tool-kit.js'

/** Cordis 插件名。 */
export const name = 'story-mode'

/**
 * 需要的宿主服务：`tools` 用来注册模型工具，`fs` 用来把路径解析成
 * 与宿主其余部分一致的目标身份（并因此遵守已挂载的后端）。
 */
export const inject = ['tools', 'fs']

/** 篇幅档位。与 `short-story` 技能里的表保持一致。 */
const TIERS = [
  { id: 'flash', label: '微型 / 闪小说', min: 3000, max: 5000 },
  { id: 'short', label: '标准短篇', min: 5000, max: 10000 },
  { id: 'novelette', label: '中短篇 / 故事集单元', min: 10000, max: 20000 },
  { id: 'series', label: '系列连载（每篇）', min: 3000, max: 10000 },
]

/**
 * 配置默认值。
 *
 * 这个包刻意不依赖 `@deepseek-ai/dsh-tools` 与 `schemastery`：它们各自的
 * 传递依赖会形成 vendor 雪球，而这个包必须能从磁盘自包含地加载。插件导出
 * 的配置对象由宿主 loader 原样传入，所以这里只声明默认值，校验在读取处
 * 用 `??` 兜底。
 */
const DEFAULT_CONFIG = {
  sceneDriftPercent: 15,
  repeatThreshold: 3,
}

/** 合并调用方配置与默认值，忽略非数值项。 */
function readConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) merged[key] = value
  }
  return merged
}

// ── 路径与读取 ──────────────────────────────────────────────────────────────

/**
 * 把模型给的路径解析成宿主文件系统的目标身份。
 *
 * 相对路径交给 `ctx.fs.resolve` 用拥有者会话的 cwd 去解析（`{ cwd }` 是它自己的
 * 选项，官方 tool-fs 也是这么传的），所以归一化口径与宿主其余部分一致；没有会话
 * 时只接受绝对路径，免得在错误的目录里静默读到另一个文件。
 */
async function resolveTarget(ctx, path, exec) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (raw.length === 0) throw new Error('path 不能为空')
  const cwd = exec?.agent?.session?.header?.cwd
  if (!isAbsolute(raw) && (cwd === undefined || cwd.length === 0)) {
    throw new Error(`相对路径 ${JSON.stringify(raw)} 无法解析：这个调用没有拥有者会话，请给绝对路径`)
  }
  const options = cwd === undefined || cwd.length === 0 ? {} : { cwd }
  return await ctx.fs.resolve(raw, { ...options, signal: exec?.signal })
}

/**
 * 读一个已解析目标的正文；目标不是文本文件时抛出。
 *
 * 顺带发 `fs/observed`：宿主默认挂的 `dsh-fs-observation-policy` 靠这组事件记录
 * "这个文件已经看过、版本是几"，没观察过的 `edit` 会被它以 `FS_NOT_OBSERVED`
 * 拒掉。官方 read / view 都发这一对事件，我们也发——这样"用 story_lint 查完直接
 * 改稿"不会白挨一次拒稿，模型不必再整篇 read 一遍。
 */
async function readTarget(ctx, target, exec) {
  const info = await ctx.fs.stat(target, exec?.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new Error(`${target.displayPath} 不存在`)
  }
  if (info.type !== 'file') throw new Error(`${target.displayPath} 不是普通文件（${info.type}）`)
  const text = await ctx.fs.readText(target, exec?.signal)
  // 观察事件要求带版本号；拿不到版本就不发，宁可少一次记录也不发一个坏事件。
  if (info.version !== undefined) {
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  }
  return text
}

// ── 字数口径 ────────────────────────────────────────────────────────────────

/**
 * 中文字数口径，与 `short-story` 技能写死的定义一致：
 * 每个 CJK 表意文字算 1 字；连续的拉丁字母/数字串算 1 字；
 * 标记符号（Markdown 记号、空格、标点）一律不计。
 *
 * Unicode script 属性包含补充平面的汉字，避免漏计罕见人名字。
 */
const CJK_SOURCE = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]'
const CJK_CHAR = new RegExp(CJK_SOURCE, 'u')
const CJK_CHAR_ALL = new RegExp(CJK_SOURCE, 'gu')
const LATIN_TOKEN_ALL = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g

/** 按口径数一段文本。 */
function countText(text) {
  const cjk = (text.match(CJK_CHAR_ALL) ?? []).length
  const latin = (text.match(LATIN_TOKEN_ALL) ?? []).length
  return cjk + latin
}

// ── 场景与段落切分 ──────────────────────────────────────────────────────────

/**
 * 场景分隔符：独占一行的 `---` / `***` / `* * *` / `···` / `◇` 之类。
 *
 * 文件开头的元数据块由 manuscriptText 先剔除，再进行场景切分。
 */
const SCENE_BREAK_LINE = /^[ \t]*(?:-{3,}|\*{3,}|\*[ \t]+\*[ \t]+\*|·{3,}|…{2,}|◇{2,}|◆{2,})[ \t]*$/
/** 标题行。正文统计必须排除它，否则标题文字会被算成正文，也会污染对话判定。 */
const HEADING_LINE = /^[ \t]*#{1,6}[ \t]+\S/

/**
 * 按给定边界把正文分组，并剔除标题行。两个切分策略共用。
 *
 * 标题行不是正文的一部分：`# 雨停之前` 算进第一个场景会让配额从一开始就偏，
 * 而且标题里的字会污染对话判定。
 */
function groupByBoundary(text, isBoundary) {
  const groups = [[]]
  for (const line of text.split(/\r?\n/)) {
    if (isBoundary(line)) {
      groups.push([])
      continue
    }
    if (HEADING_LINE.test(line) || SCENE_BREAK_LINE.test(line)) continue
    groups[groups.length - 1].push(line)
  }
  return groups.map((lines) => lines.join('\n').trim()).filter((s) => s.length > 0)
}

/**
 * 切场景。返回 { scenes, by }，`by` 说明这次用的是分隔符还是标题——
 * 报告里要写出来，否则作者会以为字数分布算错了。
 *
 * 优先用场景分隔符；它切不出两块时才退化为标题。
 */
function splitScenes(text) {
  const broken = groupByBoundary(text, (line) => SCENE_BREAK_LINE.test(line))
  if (broken.length >= 2) return { scenes: broken, by: 'scene-break' }
  const headed = groupByBoundary(text, (line) => HEADING_LINE.test(line))
  if (headed.length >= 2) return { scenes: headed, by: 'heading' }
  const scenes = headed.length === 0 ? [] : headed
  return { scenes, by: scenes.length === 0 ? 'empty' : 'single' }
}

/**
 * 段落：被空行分开的块。LF 与 CRLF 都要认。
 *
 * 返回 `{ text, line, index }`：`line` 是段首行号，`index` 是段序号（1 起）。
 * 重复词检查要报"第几段"，而段序号与行号不是一回事——稿子里有空行，也有被
 * 跳过的标题行——所以两个都得留。
 */
function splitParagraphs(text) {
  const records = []
  const lines = text.split(/\r?\n/)
  let current = []
  let start = 1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line.length === 0 || HEADING_LINE.test(line) || SCENE_BREAK_LINE.test(line)) {
      if (current.length > 0) {
        records.push({ text: current.join('\n'), line: start, index: records.length + 1 })
        current = []
      }
      continue
    }
    if (current.length === 0) start = i + 1
    current.push(line)
  }
  if (current.length > 0) records.push({ text: current.join('\n'), line: start, index: records.length + 1 })
  return records
}

/**
 * 引号内的文字涂成哨兵字符，只留下引号**外**的叙述。
 *
 * 字面线索只扫描引号外文字，人物台词交给审读员单独读。
 * 涂掉而不是删掉，是为了保持源文件行号与 UTF-16 字符位置。
 *
 * 状态跨行延续（台词可能占好几行），但在**空行处重置**：一个漏掉的引号最多
 * 污染一段，不会让整份稿子的检查静默失效。
 */
const QUOTE_CLOSER = new Map([
  ['\u201c', '\u201d'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['\u0022', '\u0022'],
])
const MASK_CHAR = '\u0001'

function maskQuotedSpans(text) {
  const closers = []
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.trim().length === 0) {
        closers.length = 0
        return line
      }
      let out = ''
      let escaped = false
      for (const char of line) {
        const inside = closers.length > 0
        const delimiter = !escaped && QUOTE_CLOSER.has(char)
        if (!escaped && inside && char === closers.at(-1)) {
          closers.pop()
        } else if (delimiter) {
          closers.push(QUOTE_CLOSER.get(char))
        }
        out += inside || delimiter ? MASK_CHAR.repeat(char.length) : char
        escaped = char === '\\' && !escaped
      }
      return out
    })
    .join('\n')
}

/**
 * 正文剥离标题行。
 *
 * 场景与总数的口径必须一致：如果一个剔标题、另一个不剔，作者会发现
 * 各场景字数相加对不上总数，然后开始怀疑这份报告。
 */
function bodyWithoutHeadings(text) {
  return text
    .split(/\r?\n/)
    .map((line) => HEADING_LINE.test(line) || SCENE_BREAK_LINE.test(line) ? '' : line)
    .join('\n')
}

/** 去掉文件开头的完整 frontmatter 块，但保留原始行号。 */
function manuscriptText(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
    // 只把带 YAML 字段的块当元数据，避免吞掉开场用的场景分隔符。
    if (end > 0 && lines.slice(1, end).some((line) => /^[\w-]+\s*:/.test(line))) {
      lines.fill('', 0, end + 1)
    }
  }
  return lines.join('\n')
}

function manuscriptVersion(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12)
}

/** 参数保持字符串形式，兼容宿主的最小 schema 子集。可包含尚未写出的后续场景。 */
function parseSceneTargets(value, sceneCount) {
  if (value === undefined || value === null) return null
  const parts = value.split(/[,，]/).map((part) => part.trim())
  if (parts.some((part) => !/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)))) {
    throw new Error('sceneTargets 必须是按场景顺序排列的正整数字数，例如 "1000,3000"')
  }
  if (parts.length < sceneCount) throw new Error(`sceneTargets 只有 ${parts.length} 项，但正文有 ${sceneCount} 场`)
  const targets = parts.map(Number)
  if (!Number.isSafeInteger(targets.reduce((a, b) => a + b, 0))) throw new Error('sceneTargets 总字数超出可计数范围')
  return targets
}

const ANY_QUOTE = /[\u201c\u201d\u300c\u300d\u300e\u300f\u0022]/u

// ── 节奏统计 ────────────────────────────────────────────────────────────────

/**
 * 重复用词（仅叙述部分，**按段计**）。
 *
 * 口径与 preset 里的 `repeatThreshold` 一致：同一个双字词在**一段**叙述里出现
 * 达到阈值才报。曾经是全文累计——真实稿子里"自己/什么/一个/时候"这类常用词会
 * 成片命中，一份没人看的报告等于没有报告。
 *
 * 只看相邻 CJK 双字组合，不将其视为已经分词的词语。没有分词器，
 * 所以用「当前字 + 后一个字」的二元组计数——对中文写作里真正刺眼的那种
 * 重复（同一个双字词在一段里连着出现四次）足够灵敏，而且完全确定。
 */
function repeatedNarrationWords(paragraphs, threshold) {
  const byWord = new Map()
  for (const paragraph of paragraphs) {
    const counts = new Map()
    const chars = [...maskQuotedSpans(paragraph.text)]
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (!CJK_CHAR.test(chars[i]) || !CJK_CHAR.test(chars[i + 1])) continue
      const word = chars[i] + chars[i + 1]
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
    for (const [word, count] of counts) {
      if (count < threshold) continue
      const entry = byWord.get(word) ?? { word, count: 0, paragraph: paragraph.index, paragraphs: 0 }
      entry.paragraphs += 1
      if (count > entry.count) {
        entry.count = count
        entry.paragraph = paragraph.index
      }
      byWord.set(word, entry)
    }
  }
  return [...byWord.values()]
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 12)
}

/** 对一段正文做一次完整分析。 */
function analyze(body, tierId, config, sceneTargets) {
  const { scenes, by } = splitScenes(body)
  const prose = bodyWithoutHeadings(body)
  const paragraphs = splitParagraphs(body)
  const total = countText(prose)

  const masked = maskQuotedSpans(prose)
  const quotedText = prose.split('').map((char, index) => masked[index] === MASK_CHAR ? char : '\n').join('')
  const dialogueChars = countText(quotedText)
  // 一次算完并舍入，报告与提示读同一个数。
  const dialoguePercent = total === 0 ? 0 : Math.round((dialogueChars / total) * 1000) / 10

  const targets = parseSceneTargets(sceneTargets, scenes.length)
  const sceneStats = scenes.map((scene, index) => {
    const chars = countText(scene)
    const target = targets?.[index] ?? null
    return {
      index: index + 1,
      chars,
      share: total === 0 ? 0 : chars / total,
      target,
      deviation: target === null ? null : Math.round((chars - target) / target * 1000) / 10,
    }
  })

  const lengths = paragraphs.map((paragraph) => countText(paragraph.text))
  const longest = lengths.length === 0 ? 0 : Math.max(...lengths)
  const average = lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length

  const tier = TIERS.find((t) => t.id === tierId)

  return {
    total,
    tier: tier ?? null,
    scenes: sceneStats,
    paragraphCount: paragraphs.length,
    dialogueChars,
    dialoguePercent,
    longestParagraph: longest,
    averageParagraph: Math.round(average * 10) / 10,
    repeats: repeatedNarrationWords(paragraphs, config.repeatThreshold ?? 3),
    notes: buildNotes({ total, tier, sceneStats, targets }, config),
    sceneSplitBy: by,
  }
}

/** 由数字推出的提示。只报事实与偏离，不评价稿子好坏。 */
function buildNotes({ total, tier, sceneStats, targets }, config) {
  const notes = []
  if (total === 0) return ['正文里没有可计数的文字。']
  if (tier && total < tier.min) notes.push('总字数 ' + total + ' 低于「' + tier.label + '」下限 ' + tier.min + '，还差 ' + (tier.min - total) + ' 字。')
  if (tier && total > tier.max) notes.push('总字数 ' + total + ' 超过「' + tier.label + '」上限 ' + tier.max + '，超出 ' + (total - tier.max) + ' 字。')
  if (targets === null) {
    notes.push('未提供 sceneTargets：只报告场景分布，不判断配额偏离，也不假设各场均分。')
  } else {
    for (const scene of sceneStats) {
      if (Math.abs(scene.deviation) >= config.sceneDriftPercent) {
        notes.push('场景 ' + scene.index + ' 实际 ' + scene.chars + ' 字，目标 ' + scene.target + ' 字，偏离 ' + scene.deviation + '%。正在写的场景可能尚未完成，请结合进度判断。')
      }
    }
    if (targets.length > sceneStats.length) notes.push('另有 ' + (targets.length - sceneStats.length) + ' 场目标尚无对应正文。')
  }
  notes.push('引号内文字仅是对话的近似量，包含引用，不含无引号台词；比例不用于判定节奏好坏。')
  return notes
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

const SCENE_SPLIT_LABEL = {
  'scene-break': '场景分隔符（独占一行的 --- / *** 等）',
  heading: '标题',
  single: '未切分（全文视为一场）',
  empty: '空文件',
}

function renderWordcount(report) {
  const lines = [
    `# ${report.file}`,
    `稿件版本：${report.version}`,
    '',
    `- 口径字数：**${report.total}**（CJK 逐字 + 拉丁词）`,
    report.tier
      ? `- 档位：${report.tier.label}（${report.tier.min}–${report.tier.max}）`
      : '- 档位：未指定（传 tier 可对比限额）',
    `- 段落：${report.paragraphCount} 段，平均 ${report.averageParagraph} 字，最长 ${report.longestParagraph} 字`,
    `- 引号内文字（对话近似）：${report.dialogueChars} 字 / 占 ${report.dialoguePercent}%`,
    `- 切分依据：${SCENE_SPLIT_LABEL[report.sceneSplitBy] ?? report.sceneSplitBy}`,
    '',
    `## 场景配额（共 ${report.scenes.length} 场）`,
    '',
    '| 场景 | 字数 | 占全文 | 目标字数 | 相对目标偏离 |',
    '|---|---|---|---|---|',
  ]
  for (const scene of report.scenes) {
    const deviation = scene.deviation === null ? '未指定目标' : (scene.deviation > 0 ? '+' : '') + scene.deviation + '%'
    lines.push('| ' + scene.index + ' | ' + scene.chars + ' | ' + Math.round(scene.share * 100) + '% | ' + (scene.target ?? '—') + ' | ' + deviation + ' |')
  }

  if (report.repeats.length > 0) {
    lines.push('', '## 引号外重复双字组合（按段计，未经分词，不代表用词错误）', '')
    lines.push(report.repeats
      .map((item) => `\`${item.word}\`×${item.count}（第 ${item.paragraph} 段${item.paragraphs > 1 ? `，共 ${item.paragraphs} 段重复` : ''}）`)
      .join('、'))
  }
  lines.push('', '## 提示', '')
  lines.push(...report.notes.map((note) => `- ${note}`))
  return lines.join('\n')
}

function renderLint(report) {
  const lines = [
    '# ' + report.file, '稿件版本：' + report.version, '',
    '口径字数 ' + report.total + '，命中 ' + report.findings.length + ' 类待审读线索。',
    '这里只定位字面形式，不判定文风违规。命中不等于要删，未命中也不表示稿件合格。',
    '视角、时态、情绪是否解释过度、节奏和必要交代由审读员结合正文与作者要求判断；pov 参数仅保留兼容，不再触发人称正则检查。', '',
  ]
  if (report.findings.length === 0) lines.push('所选规则没有字面命中。')
  for (const finding of report.findings) {
    lines.push('## ' + finding.title + ' [' + finding.id + ']（' + finding.hits.length + ' 行，共 ' + finding.total + ' 次）', '', '> ' + finding.rule, '')
    for (const hit of finding.hits) lines.push('- 第 ' + hit.line + ' 行：' + hit.text)
    lines.push('')
  }
  return lines.join('\n')
}

function renderBible(report) {
  if (report.kind === 'glossary') {
    const lines = [`# ${report.file}`, '']
    if (report.terms.length === 0) {
      lines.push(report.scoped
        ? '术语表小节里没有条目。'
        : '没有找到术语表小节，全文扫描也没有干净的一行一项条目。')
      return lines.join('\n')
    }
    lines.push(
      report.scoped
        ? `术语表小节 ${report.terms.length} 条。`
        : `未找到术语表小节，全文扫描得到 ${report.terms.length} 条（可能混入非术语条目）。`,
      '',
    )
    lines.push(...report.terms.map((t) => `- ${t}`))
    return lines.join('\n')
  }
  const lines = [
    `# ${report.file}`,
    '',
    `人物卡 ${report.entries.length} 张。`,
    '',
    '| 姓名 | 别名 / 称呼 | 缺字段 | 正文出现 |',
    '|---|---|---|---|',
  ]
  for (const entry of report.entries) {
    lines.push(
      `| ${entry.name} | ${entry.aliases.length > 0 ? entry.aliases.join('、') : '—'} | `
      + `${entry.missing.length > 0 ? entry.missing.join('、') : '—'} | `
      + `${entry.mentions === null ? '未校验' : `${entry.mentions} 次`} |`,
    )
  }
  if (report.mentionedButUncarded.length > 0) {
    lines.push(
      '',
      '## 已知事实清单中的缺卡候选（需人工确认是否为人物）',
      '',
      report.mentionedButUncarded.map((n) => `- ${n}`).join('\n'),
    )
  }
  lines.push('', '## 说明', '')
  lines.push(...report.notes.map((note) => `- ${note}`))
  return lines.join('\n')
}

// ── lint 规则表 ─────────────────────────────────────────────────────────────
//
// 每条规则对应文风契约的一节。规则名里的中文既是报告标题，也是回到契约的锚点。
//
// `scope: 'narration'` 表示这条规则只在**引号外**的叙述里匹配（台词里的用词是
// 人物在说话，不是叙述者的文风），并且要求该行确实有引号——一个提示语只有挨着
// 台词才叫提示语。这两条曾经直接在整行上匹配，于是"…当时不说，就再也没有机会
// 了"这种普通句子也被报成"提示语过密"。

const RULES = [
  {
    id: 'template-simile',
    title: '比喻与常见表达线索',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /仿佛|像是|好像|某种说不清的|某种说不出的|难以言喻|无法形容|一股[^。！？\n]{0,10}(涌上|涌起|泛起)|(心头|心里)[^。！？\n]{0,6}(一颤|一紧|一沉)/g,
  },
  {
    id: 'psychological-summary',
    title: '心理与认知表达线索',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /(他|她|它|我|你)(意识到|明白了|懂了|终于懂了|心里(泛起|涌起|升起|想到)|突然(觉得|明白|意识)|这才(明白|意识到))|这一刻[，,][^。！？\n]{0,12}(觉得|明白|意识到)|(心里|心中|心头)(一[颤紧沉酸暖凉]|五味杂陈)/g,
  },
  {
    id: 'emotion-explained',
    title: '结论式连接词线索',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /(显然|明显|看得出|看得出来|这说明|这意味着|可见他|可见她)[^。！？\n]{0,20}[。！？]?/g,
  },
  {
    id: 'dialogue-tag-overuse',
    title: '对话提示语位置（不判过密）',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /(说道|问道|答道|开口|低语|嘟囔|应道|回道|说|问|答)(?=[，,。：:\s\u0001]|$)/gm,
    scope: 'narration',
  },
  {
    id: 'emotion-adverb-tag',
    title: '修饰提示语线索',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /(?:轻声|低声|沉声|冷冷地|淡淡地|平静地|缓缓地)(?:说道|问道|答道|开口|说|问|答)|(?:说|说道|问|问道|答|答道|开口|低语|嘟囔)[，,]?\s*(声音|语气|嗓音|轻声|低声|沉声|冷冷地|淡淡地|平静地|缓缓地)[^。！？\n]{0,14}/g,
    scope: 'narration',
  },
  {
    id: 'ai-rhythm',
    title: '句式与常见表达线索（不判 AI 文风）',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /空气(仿佛)?(凝固|安静下来|静了)|时间(仿佛)?(静止|停住)|(不是[^。！？\n]{0,18}而是)|不仅[^。！？\n]{0,18}而且/g,
  },
  {
    id: 'cheap-adverb',
    title: '副词位置',
    rule: '由审读员结合上下文、作者要求和契约例外判断是否需要修改；字面命中不构成违规。',
    pattern: /(快速地|迅速地|轻轻地|深深地|静静地|缓缓地|默默地|狠狠地|微微地)/g,
  },
]

// 兼容旧调用；视角的语义判断已移交审读员。
const POV_IDS = ['first', 'third-limited', 'omniscient']

function collectFindings(text, signal, only) {
  const wanted = only?.trim() ? new Set(only.split(',').map((id) => id.trim())) : null
  if (wanted !== null) {
    const known = new Set([...RULES.map((rule) => rule.id), 'pov-drift'])
    for (const id of wanted) if (!known.has(id)) throw new Error('未知规则 ' + id + '；可选：' + [...known].join(', '))
  }
  const lines = bodyWithoutHeadings(text).split('\n')
  const maskedLines = maskQuotedSpans(lines.join('\n')).split('\n')
  const findings = []
  for (const rule of RULES) {
    if (wanted !== null && !wanted.has(rule.id)) continue
    const hits = []
    let total = 0
    for (let i = 0; i < maskedLines.length; i += 1) {
      signal?.throwIfAborted()
      if (rule.scope === 'narration' && !ANY_QUOTE.test(lines[i])) continue
      const matches = [...maskedLines[i].matchAll(rule.pattern)]
      if (matches.length === 0) continue
      total += matches.length
      const at = Math.max(0, matches[0].index - 25)
      hits.push({ line: i + 1, text: (at > 0 ? '…' : '') + lines[i].slice(at, at + 140) + (lines[i].length > at + 140 ? '…' : '') })
    }
    if (hits.length > 0) findings.push({ ...rule, hits, total })
  }
  return findings
}

// ── 设定圣经解析 ────────────────────────────────────────────────────────────

/** 人物卡标题：`## 名字`，可带 `（别名：甲 / 乙）` 或 `(别名: 甲、乙)`。 */
const CARD_HEADING = /^#{2,4}[ \t]+(.+?)[ \t]*$/gm
const ALIAS_MARKER = /[（(]\s*(?:别名|又称|昵称|称呼)\s*[:：]?\s*([^）)]*)[）)]/
/** 卡片里真正承载约束的字段。 */
const REQUIRED_FIELDS = ['身份', '动机', '关系']
/** 已知事实里可以提取专名的标记：`- **名字**：…` 或 `- 名字：…`。 */
const FACT_ENTRY = /^[ \t]*[-*][ \t]*\**([^：:*\n]{1,20})\**[ \t]*[:：]/gm

/** 结构性小节标题，不是人物卡。漏掉一个就会在报告里多出一张假卡。 */
const STRUCTURAL_HEADING = /^(人物|角色|人物卡|人物表|设定|设定圣经|已知事实|关系|关系表|时间线|术语表|专有名词|名词表|词汇表|备注|说明|目录|大纲|节拍表|glossary|characters|timeline|notes)/i

function splitCards(text) {
  const headings = [...text.matchAll(CARD_HEADING)]
  const cards = []
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]
    const start = heading.index + heading[0].length
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length
    const title = heading[1].trim()
    if (STRUCTURAL_HEADING.test(title)) continue
    cards.push({ title, body: text.slice(start, end) })
  }
  return cards
}

function parseCard(card) {
  const aliasMatch = card.title.match(ALIAS_MARKER)
  const name = card.title.replace(ALIAS_MARKER, '').trim()
  const aliases = aliasMatch === null
    ? []
    : aliasMatch[1].split(/[、,，/]/).map((s) => s.trim()).filter((s) => s.length > 0)
  const fields = new Map()
  for (const line of card.body.split(/\r?\n/)) {
    const match = line.replace(/\*\*/g, '').match(/^[ \t]*[-*]?[ \t]*(身份|动机|关系)[ \t]*[:：][ \t]*(.*)$/)
    if (match !== null && match[2].trim().length > 0) fields.set(match[1], match[2].trim())
  }
  const missing = REQUIRED_FIELDS.filter((field) => !fields.has(field))
  // 标题剥掉别名标记后为空，说明这行只是别名行而不是卡片标题——丢弃。
  if (name.length === 0) return null
  return { name, aliases: [...new Set(aliases)].filter((alias) => alias !== name), missing }
}

/** 从「已知事实」一类的清单里抽出被提到的专名。 */
function factsNames(text) {
  const names = new Set()
  const heading = text.match(/^#{1,4}[ \t]+已知事实[ \t]*$/m)
  if (heading === null) return []
  const rest = text.slice(heading.index + heading[0].length)
  const section = rest.split(/^#{1,4}[ \t]+/m)[0]
  for (const match of section.matchAll(FACT_ENTRY)) {
    const candidate = match[1].trim()
    if (!CARD_FIELD_LABEL.test(candidate) && candidate.length >= 2 && candidate.length <= 10 && CJK_CHAR.test(candidate)) names.add(candidate)
  }
  return [...names]
}

function countMentions(text, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/** 同一卡的姓名/别名按最长匹配计数，避免「林远」与「小林远」重叠累计。 */
function countCardMentions(text, needles) {
  const spans = []
  for (const needle of new Set(needles)) {
    if (needle.length === 0) continue
    let at = text.indexOf(needle)
    while (at !== -1) {
      spans.push({ start: at, end: at + needle.length })
      at = text.indexOf(needle, at + needle.length)
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let end = -1
  let count = 0
  for (const span of spans) {
    if (span.start < end) continue
    count += 1
    end = span.end
  }
  return count
}

// ── 术语表解析 ──────────────────────────────────────────────────────────────

/** 术语表小节标题。没找到小节时退回全文扫描。 */
const GLOSSARY_HEADING = /^#{1,4}[ \t]*(?:术语表|专有名词|名词表|glossary)[ \t]*$/im
/** 任何标题行——小节标题本身不是术语。 */
const ANY_HEADING_LINE = /^[ \t]*#{1,6}[ \t]+\S/
/** 人物卡的字段标签：它们长得像术语，但属于卡片结构。 */
const CARD_FIELD_LABEL = /^(身份|动机|关系|年龄|外貌|口头禅|已知事实|备注|别名|称呼|背景|性格)$/

/** 抽出一份清单里的条目。只认干净的一行一项，避免把描述当术语。 */
function parseListEntries(text) {
  const seen = new Set()
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    if (ANY_HEADING_LINE.test(line)) continue
    const match = line.match(/^[ \t]*[-*+][ \t]*\**([^*：:\n]{1,24}?)\**((?:[ \t]*[（(][^）)]*[）)])?)[ \t]*(?:[:：].*)?$/)
    if (match === null) continue
    const term = match[1].trim()
    const note = (match[2] ?? '').trim()
    if (term.length === 0 || CARD_FIELD_LABEL.test(term)) continue
    // 括号里是描述而不是别名时，条目本身就带解释——只保留短语。
    if (term.includes('，') || term.includes(',') || term.length > 12) continue
    if (seen.has(term)) continue
    seen.add(term)
    entries.push(note.length > 0 ? `${term} ${note}` : term)
  }
  return entries
}

/** 术语表小节优先；没有小节就扫全文。 */
function parseGlossary(raw) {
  const heading = raw.match(GLOSSARY_HEADING)
  if (heading === null) return { terms: parseListEntries(raw), scoped: false }
  const start = heading.index + heading[0].length
  const rest = raw.slice(start)
  const nextHeading = rest.match(/^#{1,4}[ \t]+\S.*$/m)
  const section = nextHeading === null ? rest : rest.slice(0, nextHeading.index)
  return { terms: parseListEntries(section), scoped: true }
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

const TIER_IDS = TIERS.map((t) => t.id)

function makeWordcountTool(ctx, config) {
    return makeTool({
    name: 'story_wordcount',
    description: [
      'Short story word-count and pacing meter. Counts by the project word convention (each CJK character = 1, each latin/number token = 1),',
      'splits the manuscript into scenes (on a standalone `---`/`***` line, falling back to headings), and reports per-scene deviation only when sceneTargets is provided,',
      'quoted-text ratio (a dialogue approximation, not a quality score), paragraph lengths, and repeated two-character combinations outside quotes within a paragraph.',
      'Use it instead of estimating Chinese length by eye — the numbers you report to the author must come from this tool.',
      '`tier` compares the total against a length band; omit it to just measure.',
      'Read-only: it never writes the manuscript.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Manuscript path. Absolute, or relative to the session working directory.' },
      sceneTargets: { type: 'string', description: 'Confirmed outline targets in scene order, e.g. 1000,3000. Positive integers separated by commas; may include unwritten future scenes. Omit to report distribution only.' },
      tier: { type: 'string', enum: TIER_IDS, description: 'Length band to compare against: flash 3000-5000, short 5000-10000, novelette 10000-20000, series 3000-10000 per piece.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `字数与节奏 ${args.path}`, kind: 'read', rawInput: args.path }),
    async run(args, exec) {
      const target = await resolveTarget(ctx, args.path, exec)
      const raw = await readTarget(ctx, target, exec)
      const report = analyze(manuscriptText(raw), args.tier, config, args.sceneTargets)
      return renderWordcount({ ...report, file: target.displayPath, version: manuscriptVersion(raw) })
    },
  })
}

function makeLintTool(ctx) {
  return makeTool({
    name: 'story_lint',
    description: 'Read-only lexical clues for manuscript review, not violations. Matches outside quotes need contextual review before editing. Does not judge POV, tense, emotion, pacing, or literary quality. Includes manuscript version and source line numbers.',
    parameters: {
      path: { type: 'string', required: true, description: 'Manuscript path. Absolute, or relative to the session working directory.' },
      only: { type: 'string', description: 'Optional comma-separated rule ids: ' + RULES.map((rule) => rule.id).join(', ') + '. Legacy pov-drift is accepted but no longer checks pronouns.' },
      pov: { type: 'string', enum: POV_IDS, description: 'Deprecated, accepted for compatibility only. POV is reviewed in context by a reader; no pronoun-based check is performed.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `文风检查 ${args.path}`, kind: 'read', rawInput: args.path }),
    async run(args, exec) {
      const target = await resolveTarget(ctx, args.path, exec)
      const raw = await readTarget(ctx, target, exec)
      const body = manuscriptText(raw)
      const findings = collectFindings(body, exec?.signal, args.only)
      return renderLint({ file: target.displayPath, version: manuscriptVersion(raw), total: countText(bodyWithoutHeadings(body)), findings })
    },
  })
}

function makeBibleTool(ctx) {
  return makeTool({
    name: 'story_bible',
    description: [
      'Read a story bible and validate it. `kind: characters` parses `## 名字` cards, extracts aliases from a `（别名：甲 / 乙）` marker,',
      'reports missing or empty 身份/动机/关系 fields and, with `draft`, literal name/alias occurrences (not semantic identity).',
      'Uncarded candidates come ONLY from named list entries under 已知事实; this is not name recognition or spelling validation. Reviewers check new characters and consistency. `kind: glossary` lists terms only.',
      'Read-only: edit the bible with your normal file tools so writes still go through the host sandbox.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Bible path (or glossary path for kind=glossary). Absolute, or relative to the session working directory.' },
      kind: { type: 'string', enum: ['characters', 'glossary'], description: 'characters (default) parses 人物卡; glossary lists 术语.' },
      draft: { type: 'string', description: 'Optional manuscript path to cross-check mentions against.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `设定圣经 ${args.path}`, kind: 'read', rawInput: args.path }),
    async run(args, exec) {
      const target = await resolveTarget(ctx, args.path, exec)
      const raw = await readTarget(ctx, target, exec)

      if (args.kind === 'glossary') {
        const { terms, scoped } = parseGlossary(raw)
        return renderBible({ kind: 'glossary', file: target.displayPath, terms, scoped })
      }

      const cards = splitCards(raw).map(parseCard).filter((card) => card !== null)
      const notes = []

      let draftText = null
      if (typeof args.draft === 'string' && args.draft.trim().length > 0) {
        const draftTarget = await resolveTarget(ctx, args.draft, exec)
        draftText = await readTarget(ctx, draftTarget, exec)
      }

      const entries = cards.map((card) => {
        if (draftText === null) return { ...card, mentions: null }
        const needles = [card.name, ...card.aliases]
        const mentions = countCardMentions(draftText, needles)
        return { ...card, mentions }
      })

      // 仅核对已知事实清单中的候选条目，不做正文实体识别。
      let mentionedButUncarded = []
      if (draftText !== null) {
        const carded = new Set(entries.flatMap((e) => [e.name, ...e.aliases]))
        mentionedButUncarded = factsNames(raw)
          .filter((n) => !carded.has(n) && countMentions(draftText, n) >= 2)
          .slice(0, 20)
      }

      if (entries.length === 0) {
        notes.push('没有解析到人物卡——卡片标题需要是 `## 名字` 形式。')
      }
      const incomplete = entries.filter((e) => e.missing.length > 0)
      if (incomplete.length > 0) {
        notes.push(`有 ${incomplete.length} 张卡字段缺失或为空（身份 / 动机 / 关系）；格式为「- 字段：内容」。`)
      }
      if (draftText === null) {
        notes.push('没有传 draft，因此未做正文提及次数与缺卡检查。')
      } else if (mentionedButUncarded.length > 0) {
        notes.push('下面这些名字在正文出现 ≥2 次但设定圣经里没有卡片——确认它们是人物还是普通名词。')
      }
      if (entries.length > 0 && incomplete.length === 0) notes.push('人物卡必填字段均有文字；不代表动机、关系或设定合理。')
      notes.push('提及次数是字面匹配，不识别同名人物或代词。缺卡候选仅来自「已知事实」清单，不自动识别正文新人物或核验专名拼写；这些交给故事逻辑审读。')

      return renderBible({ kind: 'characters', file: target.displayPath, version: manuscriptVersion(raw), entries, mentionedButUncarded, notes })
    },
  })
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

/**
 * 注册四个只读工具。
 *
 * `ctx.tools.register` 返回精确的 disposer，但注册本身已经挂在当前 fiber 上，
 * 所以这里不需要额外的 ctx.effect —— 插件卸载时四个工具一起消失。
 *
 * `story_doctor` 来自 `./doctor.js`：它同时是独立入口 `dsh-story-mode/doctor`，
 * 两个入口共用一个实现，因此不会漂移。
 */
export function apply(ctx, config) {
  const resolved = readConfig(config)
  ctx.tools.register(makeWordcountTool(ctx, resolved))
  ctx.tools.register(makeLintTool(ctx))
  ctx.tools.register(makeBibleTool(ctx))
  ctx.tools.register(doctorTool())
}
