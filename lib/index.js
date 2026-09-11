/**
 * dsh-story-mode —— 短篇小说模式。**整套模式都在这一个包里。**
 *
 * 包结构：
 *   lib/index.js                              本文件：写作工具（主入口）
 *   lib/doctor.js                             安装自检，独立入口 `dsh-story-mode/doctor`
 *   lib/tool-kit.js                           零依赖的工具构造器与参数校验（两个入口共用）
 *   presets/short-story/agent.cordis.yml      **模式本身**（人设 + 工具行 + 流程入口）
 *   presets/short-story/preset.yml            模式在 roster 里的显示名与描述
 *   presets/short-story/skills/               写作流程技能（形态识别 / 档位 / 四阶段）
 *   skills/writing-style-contract/            文风契约（由 preset 从包内挂载，只在本模式生效）
 *   cordis.patch.yml                          把包内 presets/ 声明为 roster 的一个根
 *   bin/cli.mjs + scripts/cleanup.mjs         卸载前清理（不安装任何东西）
 *
 * **两个独立入口**（`exports` 子路径，同包多入口是框架支持的正规形态）：
 *   `.`         写作模式挂载它——四个工具全部注册
 *   `./doctor`  只注册 `story_doctor`，可单独挂到任何模式（例如创造模式做诊断），
 *               不必连带加载写作工具。两个入口共用 `tool-kit.js`，不会漂移。
 *
 * "整套都在这一个包里"是靠**运行时定位本包**做到的，没有任何一步把文件复制到
 * 用户的 home，也没有"装完还要再跑一条命令"：
 *   * 模式：`cordis.patch.yml` 在 profile 合成配置时用 `createRequire(ctx.baseUrl)`
 *     问出本包装在哪，把包内 `presets/` 声明为 roster 的一个根。卸载包，模式消失。
 *   * 技能：技能根由 preset 自己声明——那一行的 `customSkillDirs` 以 preset 文件
 *     所在目录为基准（`!!js` 里的 `baseUrl`），挂上包内的两个 skills/ 目录。
 *   * preset 行的 `name` 不能用 `!!js` 动态算路径：发现阶段确实支持 `!!js`，但
 *     紧随其后的形状检查要求 `name` 是字符串，`!!js` 解析出来是对象，整份组成
 *     会被判为 broken。
 *   * 裸包名也不能用：它从 harness 解析，而 preset 在用户目录下，向上查找到不了
 *     harness 自己的依赖。所以组成里用相对引用 `../../lib/index.js`。
 *
 * 文风契约**不**落地到 `<DSH_HOME>/skills`：那是用户根，每个 preset 的
 * skill-filesystem 实例都会扫它，放进去等于让它出现在所有模式（含编码会话）里。
 * 它只属于写作模式，所以只从 preset 那一层挂载。
 *
 * 这个包存在的理由是：写小说时唯一能验证稿件的东西是**程序**，不是模型的直觉。
 * 中文字数、场景配额偏差、对话与叙述的比例、专名拼写、模板化比喻——这些都能
 * 由确定性代码判定，不该让模型"感觉一下"。剩下的（结构、语气、人物）才交给模型。
 *
 * 四个工具（全部只读）：
 *   story_wordcount —— 字数口径、场景配额、对话比、最长段落（节奏仪表）
 *   story_lint      —— 文风契约的确定性检查 + 视角/时态/专名一致性 + 过度重复
 *   story_bible     —— 读设定圣经、校验人物卡格式与专名跨文件一致性
 *   story_doctor    —— 安装自检：是否落地、内容是否过期、roster 能否发现
 *
 * 四个工具都不写文件。稿件与设定圣经的修改走作者的常规文件工具
 * （read / write / edit / str_replace_editor），所以写入仍然经过宿主挂载的
 * 文件策略与沙箱。这样插件不必、也不应该自己发明一套写入通道。
 *
 * 只发布模型工具，不发布服务，因此按宿主组成挂载即可，不需要 isolate realm。
 *
 * 依赖：**零运行时依赖**。刻意不 import 任何 `@deepseek-ai/*` 包——它们各自的
 * 传递依赖会形成 vendor 雪球，而这个包必须能从磁盘自包含地加载（它的位置在
 * 用户目录下，Node 的 node_modules 向上查找到不了 harness 自己的依赖）。
 *
 * @module dsh-story-mode
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
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
  { id: 'flash', label: '微型 / 闪小说', min: 1000, max: 3000 },
  { id: 'short', label: '标准短篇', min: 3000, max: 8000 },
  { id: 'novelette', label: '中短篇 / 故事集单元', min: 8000, max: 20000 },
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
  dialogueLowPercent: 20,
  dialogueHighPercent: 70,
  repeatThreshold: 3,
}

/** 合并调用方配置与默认值，忽略非数值项。 */
function readConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value
  }
  return merged
}

// ── 路径与读取 ──────────────────────────────────────────────────────────────

/**
 * 把模型给的路径解析成宿主文件系统的目标身份。
 *
 * 优先用拥有者会话的 cwd 解析相对路径；没有会话时只接受绝对路径。
 * 这样 `draft.md` 与 `C:\\...\\draft.md` 都能用，而不会在错误的目录里
 * 静默读到另一个文件。
 */
async function resolveTarget(ctx, path, exec) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (raw.length === 0) throw new Error('path 不能为空')
  const cwd = exec?.agent?.session?.header?.cwd
  const absolute = isAbsolute(raw) ? raw : cwd === undefined ? undefined : resolvePath(cwd, raw)
  if (absolute === undefined) {
    throw new Error(`相对路径 ${JSON.stringify(raw)} 无法解析：这个调用没有拥有者会话，请给绝对路径`)
  }
  return await ctx.fs.resolve(absolute, { signal: exec?.signal })
}

/** 读一个已解析目标的正文；目标不是文本文件时抛出。 */
async function readTarget(ctx, target, signal) {
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) throw new Error(`${target.displayPath} 不存在`)
  if (info.type !== 'file') throw new Error(`${target.displayPath} 不是普通文件（${info.type}）`)
  return await ctx.fs.readText(target, signal)
}

// ── 字数口径 ────────────────────────────────────────────────────────────────

/**
 * 中文字数口径，与 `short-story` 技能写死的定义一致：
 * 每个 CJK 表意文字算 1 字；连续的拉丁字母/数字串算 1 字；
 * 标记符号（Markdown 记号、空格、标点）一律不计。
 *
 * 用打包在一起的区间而不是字符类字面量，是为了避免把不可见字符
 * 直接写进源码。
 */
const CJK_SOURCE = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af]'
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
 * 注意 YAML frontmatter 的 `---` 在文件最开头，切出来的第一段会是空的，
 * 由调用方过滤，所以这里不必特判。
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
    if (HEADING_LINE.test(line)) continue
    if (isBoundary(line)) {
      groups.push([])
      continue
    }
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

/** 段落：被空行分开的块。LF 与 CRLF 都要认。 */
function splitParagraphs(text) {
  return text.split(/\r?\n[ \t]*\r?\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
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
    .filter((line) => !HEADING_LINE.test(line))
    .join('\n')
    .trim()
}

/**
 * 对话行判定。中文小说有两种排版习惯，都要认：
 *   「……」 / “……” 独占一行；
 *   或者以引号开头，后面跟提示语（“……” 他说。）。
 *
 * 引号一律用 Unicode 转义而不是字面量：弯引号 U+201C/U+201D 与直引号
 * U+0022 在源码里长得几乎一样，任何一次编码往返都可能把它们悄悄互换，
 * 而后果是对话统计静默归零——最难发现的那类 bug。
 */
const QUOTE_CHARS = '\u201c\u201d\u300c\u300d\u300e\u300f\u0022'
const QUOTE_OPEN = new RegExp(`^[ \\t]*(?:[${QUOTE_CHARS}]|&quot;)`, 'u')
const ANY_QUOTE = new RegExp(`[${QUOTE_CHARS}]`, 'u')
const SPEECH_VERB = /(说|说道|问|问道|答|答道|喊|道|嘟囔|低语|开口|回)/u

function isDialogueParagraph(paragraph) {
  return QUOTE_OPEN.test(paragraph) || (ANY_QUOTE.test(paragraph) && SPEECH_VERB.test(paragraph))
}

// ── 节奏统计 ────────────────────────────────────────────────────────────────

/** 叙事面向的字符集边界，用来判断某个字是否在单词内部。 */
const WORDY = /[\p{L}\p{N}]/u

/**
 * 重复用词（仅叙述部分）。
 *
 * 只看长度 ≥ 2 的 CJK 词，因为单字重复在中文里是正常语法。没有分词器，
 * 所以用「当前字 + 后一个字」的二元组计数——对中文写作里真正刺眼的那种
 * 重复（同一个双字词在一段里出现四次）足够灵敏，而且完全确定。
 */
function repeatedNarrationWords(paragraphs, threshold) {
  const counts = new Map()
  for (const paragraph of paragraphs) {
    if (isDialogueParagraph(paragraph)) continue
    const chars = [...paragraph]
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (!CJK_CHAR.test(chars[i]) || !CJK_CHAR.test(chars[i + 1])) continue
      const word = chars[i] + chars[i + 1]
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
}

/** 对一段正文做一次完整分析。 */
function analyze(body, tierId, config) {
  const { scenes, by } = splitScenes(body)
  const prose = bodyWithoutHeadings(body)
  const paragraphs = splitParagraphs(prose)
  const total = countText(prose)

  const dialogueParagraphs = paragraphs.filter(isDialogueParagraph)
  const dialogueChars = dialogueParagraphs.reduce((sum, p) => sum + countText(p), 0)
  // 一次算完并舍入，报告与提示读同一个数。
  const dialoguePercent = total === 0 ? 0 : Math.round((dialogueChars / total) * 1000) / 10

  const sceneStats = scenes.map((scene, index) => {
    const chars = countText(scene)
    return { index: index + 1, chars, share: total === 0 ? 0 : chars / total }
  })

  const lengths = paragraphs.map((p) => countText(p))
  const longest = lengths.length === 0 ? 0 : Math.max(...lengths)
  const average = lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length

  const tier = TIERS.find((t) => t.id === tierId)

  return {
    total,
    tier: tier ?? null,
    scenes: sceneStats,
    paragraphCount: paragraphs.length,
    dialogueParagraphs: dialogueParagraphs.length,
    dialogueChars,
    dialoguePercent,
    longestParagraph: longest,
    averageParagraph: Math.round(average * 10) / 10,
    repeats: repeatedNarrationWords(paragraphs, config.repeatThreshold ?? 3),
    notes: buildNotes({ total, tier, sceneStats, dialoguePercent, by }, config),
    sceneSplitBy: by,
  }
}

/** 由数字推出的提示。只报事实与偏离，不评价稿子好坏。 */
function buildNotes({ total, tier, sceneStats, dialoguePercent, by }, config) {
  const notes = []
  const drift = config.sceneDriftPercent ?? 15

  if (total === 0) {
    return ['正文里没有可计数的文字。']
  }

  if (tier) {
    if (total < tier.min) {
      notes.push(`总字数 ${total} 低于「${tier.label}」档位下限 ${tier.min}，还差 ${tier.min - total} 字。`)
    } else if (total > tier.max) {
      notes.push(`总字数 ${total} 超过「${tier.label}」档位上限 ${tier.max}，超出 ${total - tier.max} 字。`)
    }
  }

  if (sceneStats.length > 1) {
    const even = 1 / sceneStats.length
    for (const scene of sceneStats) {
      const deviation = Math.round((scene.share - even) * 100)
      if (Math.abs(deviation) >= drift) {
        const direction = deviation > 0 ? '偏重' : '偏轻'
        notes.push(
          `场景 ${scene.index} 占全文 ${Math.round(scene.share * 100)}%，`
          + `相对均分 ${Math.round(even * 100)}% ${direction} ${Math.abs(deviation)} 个百分点（${scene.chars} 字）。`,
        )
      }
    }
  } else if (by === 'single' && tier && total > tier.max) {
    notes.push('全文只有一段，没有场景分隔符——超过单场景容量时用独占一行的 `---` 切分。')
  }

  const low = config.dialogueLowPercent ?? 20
  const high = config.dialogueHighPercent ?? 70
  if (dialoguePercent < low) {
    notes.push(`对话占 ${dialoguePercent}%，低于 ${low}%——叙述连续篇幅偏长，朗读节奏可能发闷。`)
  } else if (dialoguePercent > high) {
    notes.push(`对话占 ${dialoguePercent}%，高于 ${high}%——场景与身体动作偏少，人物可能悬在空中。`)
  }

  if (notes.length === 0) notes.push('各项指标都在档位与配额之内。')
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
    '',
    `- 口径字数：**${report.total}**（CJK 逐字 + 拉丁词）`,
    report.tier
      ? `- 档位：${report.tier.label}（${report.tier.min}–${report.tier.max}）`
      : '- 档位：未指定（传 tier 可对比限额）',
    `- 段落：${report.paragraphCount} 段，平均 ${report.averageParagraph} 字，最长 ${report.longestParagraph} 字`,
    `- 对话：${report.dialogueParagraphs} 段 / 占 ${report.dialoguePercent}%`,
    `- 切分依据：${SCENE_SPLIT_LABEL[report.sceneSplitBy] ?? report.sceneSplitBy}`,
    '',
    `## 场景配额（共 ${report.scenes.length} 场）`,
    '',
    '| 场景 | 字数 | 占全文 | 均分 | 偏离 |',
    '|---|---|---|---|---|',
  ]
  const even = report.scenes.length === 0 ? 0 : 100 / report.scenes.length
  for (const scene of report.scenes) {
    const share = Math.round(scene.share * 100)
    const deviation = share - Math.round(even)
    lines.push(
      `| ${scene.index} | ${scene.chars} | ${share}% | ${Math.round(even)}% | `
      + `${deviation === 0 ? '—' : `${deviation > 0 ? '+' : ''}${deviation}`} |`,
    )
  }
  if (report.repeats.length > 0) {
    lines.push('', '## 叙述段里的重复词', '')
    lines.push(report.repeats.map(([word, n]) => `\`${word}\`×${n}`).join('、'))
  }
  lines.push('', '## 提示', '')
  lines.push(...report.notes.map((note) => `- ${note}`))
  return lines.join('\n')
}

function renderLint(report) {
  const lines = [
    `# ${report.file}`,
    '',
    `口径字数 ${report.total}，检查 ${report.findings.length} 处。`,
    '',
  ]
  if (report.findings.length === 0) {
    lines.push('没有命中任何条款。')
    return lines.join('\n')
  }
  for (const finding of report.findings) {
    lines.push(`## ${finding.title}（${finding.hits.length} 处，共 ${finding.total} 次）`)
    lines.push('', `> ${finding.rule}`, '')
    for (const hit of finding.hits.slice(0, 6)) {
      lines.push(`- 第 ${hit.line} 行：${hit.text}`)
    }
    if (finding.hits.length > 6) lines.push(`- …另有 ${finding.hits.length - 6} 处`)
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
      '## 正文里出现但设定圣经没有的人物',
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
// 每条规则对应 `references/style-contract.md` 的一节。规则名里的中文既是
// 报告标题，也是回到契约的锚点。

const RULES = [
  {
    id: 'template-simile',
    title: '模板化比喻（契约三）',
    rule: '`仿佛` / `像是` / `好像` 开头的明喻，以及 `某种说不清的`、`难以言喻的`、`一股…涌上`。除非提供了真正新的信息，否则删除。',
    pattern: /仿佛|像是|好像|某种说不清的|某种说不出的|难以言喻|无法形容|一股[^。！？\n]{0,10}(涌上|涌起|泛起)|(心头|心里)[^。！？\n]{0,6}(一颤|一紧|一沉)/g,
    minLength: 1,
  },
  {
    id: 'psychological-summary',
    title: '心理总结（契约七）',
    rule: '`他意识到` / `他明白` / `他心里泛起` / `这一刻，他突然觉得`。不主动总结人物心理——除非心理变化本身就是剧情重点。',
    pattern: /(他|她|它|我|你)(意识到|明白了|懂了|终于懂了|心里(泛起|涌起|升起|想到)|突然(觉得|明白|意识)|这才(明白|意识到))|这一刻[，,][^。！？\n]{0,12}(觉得|明白|意识到)|(心里|心中|心头)(一[颤紧沉酸暖凉]|五味杂陈)/g,
    minLength: 1,
  },
  {
    id: 'emotion-explained',
    title: '解释已能看出的情绪（契约六）',
    rule: '`显然` / `看得出` / `这说明` / `他生气了` 这类替读者下结论的句子。改成事实（一个动作、一件物品）。',
    pattern: /(显然|明显|看得出|看得出来|这说明|这意味着|可见他|可见她)[^。！？\n]{0,20}[。！？]?/g,
    minLength: 1,
  },
  {
    id: 'dialogue-tag-overuse',
    title: '对话提示语过密（契约五）',
    rule: '`他说` / `她说道` / `他开口` 这类提示语。说话人明确时直接写台词；需要区分时优先用自然动作。',
    pattern: /(说|说道|问道|答道|开口|低语|嘟囔|应道|回道)(?=[，,。：:"「]|$)/gm,
    minLength: 1,
  },
  {
    id: 'emotion-adverb-tag',
    title: '情绪修饰式提示语（契约五）',
    rule: '`他说，声音平静得…` / `她轻声说道` 这类把情绪塞进提示语的写法。改成动作，或者直接删掉提示语。',
    pattern: /(说|说道|问|问道|答|答道|开口|低语|嘟囔)[，,]?\s*(声音|语气|嗓音|轻声|低声|沉声|冷冷地|淡淡地|平静地|缓缓地)[^。！？\n]{0,14}/g,
    minLength: 1,
  },
  {
    id: 'pov-drift',
    title: '视角滑移（契约二 / 接稿单）',
    rule: '第二人称与第一人称代词混用，或全知视角词（`与此同时` / `殊不知` / `另一边`）出现在限知叙事里。视角一旦定下就不该滑动。',
    pattern: /你(们)?(?=[\u4e00-\u9fff])|与此同时|殊不知|另一边[，,]/g,
    minLength: 1,
  },
  {
    id: 'ai-rhythm',
    title: 'AI 节奏（契约十）',
    rule: '`不是…而是…`、`不仅…而且…` 这类整齐句式，以及 `空气凝固` / `时间静止` 这类成句。段落长度也要有变化。',
    pattern: /空气(仿佛)?(凝固|安静下来|静了)|时间(仿佛)?(静止|停住)|(不是[^。！？\n]{0,18}而是)|不仅[^。！？\n]{0,18}而且/g,
    minLength: 1,
  },
  {
    id: 'cheap-adverb',
    title: '副词补动词（契约二）',
    rule: '`快速地` / `轻轻地` / `深深地` / `静静地` 这类副词多半在补一个本该由动词本身承担的信息。',
    pattern: /(快速地|迅速地|轻轻地|深深地|静静地|缓缓地|默默地|狠狠地|微微地)/g,
    minLength: 1,
  },
]

/**
 * 同一行内的多处命中合并为一条，取整行文本（去首尾空白）作为样本。
 * 这样报告读起来像改稿意见，而不是正则结果。
 */
function collectFindings(text, signal) {
  const lines = text.split(/\r?\n/)
  const findings = []
  for (const rule of RULES) {
    const hits = []
    let total = 0
    for (let i = 0; i < lines.length; i += 1) {
      signal?.throwIfAborted()
      const line = lines[i]
      const matches = line.match(rule.pattern)
      if (matches === null || matches.length === 0) continue
      total += matches.length
      if (matches.length < (rule.minLength ?? 1)) continue
      const trimmed = line.trim()
      hits.push({ line: i + 1, text: trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed })
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
  const missing = REQUIRED_FIELDS.filter((field) => !new RegExp(`(^|\\n)[ \\t]*[-*]?[ \\t]*\\**${field}\\**`).test(card.body))
  // 标题剥掉别名标记后为空，说明这行只是别名行而不是卡片标题——丢弃。
  if (name.length === 0) return null
  return { name, aliases, missing }
}

/** 从「已知事实」一类的清单里抽出被提到的专名。 */
function factsNames(text) {
  const names = new Set()
  for (const match of text.matchAll(FACT_ENTRY)) {
    const candidate = match[1].trim()
    if (candidate.length >= 2 && candidate.length <= 10 && CJK_CHAR.test(candidate)) names.add(candidate)
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
      'splits the manuscript into scenes (on a standalone `---`/`***` line, falling back to headings), and reports per-scene quota deviation,',
      'dialogue-vs-narration ratio, paragraph lengths, and repeated two-character words in narration.',
      'Use it instead of estimating Chinese length by eye — the numbers you report to the author must come from this tool.',
      '`tier` compares the total against a length band; omit it to just measure.',
      'Read-only: it never writes the manuscript.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Manuscript path. Absolute, or relative to the session working directory.' },
      tier: { type: 'string', enum: TIER_IDS, description: 'Length band to compare against: flash 1000-3000, short 3000-8000, novelette 8000-20000, series 3000-10000 per piece.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `字数与节奏 ${args.path}`, kind: 'read', rawInput: args.path }),
    async run(args, exec) {
      const target = await resolveTarget(ctx, args.path, exec)
      const raw = await readTarget(ctx, target, exec?.signal)
      const report = analyze(raw, args.tier, config)
      return renderWordcount({ ...report, file: target.displayPath })
    },
  })
}

function makeLintTool(ctx) {
  return makeTool({
    name: 'story_lint',
    description: [
      'Deterministic style-contract check for a manuscript. Reports only measured evidence — never an opinion about quality.',
      'Covers: template similes and stock phrases, psychological-summary sentences, emotions explained outright, over-dense dialogue tags,',
      'emotion-adverb tags, POV drift, AI-rhythm clichés, and filler adverbs.',
      'Call it after the self-revision pass, then handle each finding; explain in your report any finding you deliberately do not adopt.',
      'Read-only.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Manuscript path. Absolute, or relative to the session working directory.' },
      only: { type: 'string', description: 'Optional comma-separated rule ids to restrict the check to.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `文风检查 ${args.path}`, kind: 'read', rawInput: args.path }),
    async run(args, exec) {
      const target = await resolveTarget(ctx, args.path, exec)
      const raw = await readTarget(ctx, target, exec?.signal)
      let findings = collectFindings(raw, exec?.signal)
      if (typeof args.only === 'string' && args.only.trim().length > 0) {
        const wanted = new Set(args.only.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
        findings = findings.filter((f) => wanted.has(f.id))
      }
      return renderLint({ file: target.displayPath, total: countText(bodyWithoutHeadings(raw)), findings })
    },
  })
}

function makeBibleTool(ctx) {
  return makeTool({
    name: 'story_bible',
    description: [
      'Read a story bible and validate it. `kind: characters` parses `## 名字` cards, extracts aliases from a `（别名：甲 / 乙）` marker,',
      'reports which cards are missing 身份/动机/关系, and — when you also pass `draft` — how often each name actually appears in the',
      'manuscript plus the names the draft mentions that have no card. `kind: glossary` lists the 专有名词 terms.',
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
      const raw = await readTarget(ctx, target, exec?.signal)

      if (args.kind === 'glossary') {
        const { terms, scoped } = parseGlossary(raw)
        return renderBible({ kind: 'glossary', file: target.displayPath, terms, scoped })
      }

      const cards = splitCards(raw).map(parseCard).filter((card) => card !== null)
      const notes = []

      let draftText = null
      if (typeof args.draft === 'string' && args.draft.trim().length > 0) {
        const draftTarget = await resolveTarget(ctx, args.draft, exec)
        draftText = await readTarget(ctx, draftTarget, exec?.signal)
      }

      const entries = cards.map((card) => {
        if (draftText === null) return { ...card, mentions: null }
        const needles = [card.name, ...card.aliases]
        const mentions = needles.reduce((sum, needle) => sum + countMentions(draftText, needle), 0)
        return { ...card, mentions }
      })

      // 反向检查：正文里像人名的双字/三字词没有卡片。规则保守——只在
      // 出现次数足够多时才提示，避免把普通名词当人物报出来。
      let mentionedButUncarded = []
      if (draftText !== null && entries.length > 0) {
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
        notes.push(`有 ${incomplete.length} 张卡缺字段（身份 / 动机 / 关系）。人物卡只写约束，不写形容词。`)
      }
      if (draftText === null) {
        notes.push('没有传 draft，因此未做正文提及次数与缺卡检查。')
      } else if (mentionedButUncarded.length > 0) {
        notes.push('下面这些名字在正文出现 ≥2 次但设定圣经里没有卡片——确认它们是人物还是普通名词。')
      }
      if (notes.length === 0) notes.push('人物卡结构与字段齐全。')

      return renderBible({ kind: 'characters', file: target.displayPath, entries, mentionedButUncarded, notes })
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
