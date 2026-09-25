/**
 * `dsh-story-mode/doctor` —— 安装自检（DSH 0.1.7-rc.1 及以后）。
 *
 * 这套能力的落地方式分两半，自检必须分开回答，因为失败模式完全不同：
 *
 * ── 一半是模式：**自动**，由包的两层 bundle patch 各插入一行 preset 声明 ──────
 *
 * 0.1.7 起，preset 不再是"文件系统上的目录"，而是普通的 loader 行：
 * `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 就是子插件列表，注册表
 * （`ctx.agentPresets`）**不扫描目录，也不接受预设路径**。所以本包只做一件事：
 * 在 bundle patch 里 `insert` 一行 preset 声明。装好包、重启一次 profile，
 * 模式就在列表里；卸载包，这些 patch 消失，两个模式一起消失。
 *
 * 包里有**两个**模式，住在两个互不依赖的 patch 文件里（`package.json` 的
 * `dsh.bundle.patch` 是路径数组，两层都会被读）：
 *
 *   * `cordis.patch.yml`      → `preset-short-story`，config.id `short-story`，
 *                               五位角色化只读审读员，技能根 `skills/`；
 *   * `cordis.lite.patch.yml` → `preset-short-story-lite`，
 *                               config.id `short-story-lite`，一位合并审读员
 *                               （`subagent_review`，人设 = `skills-lite/references/reviewer-merged.md`
 *                               + 换行 + 文风契约），技能根 `skills-lite/` 与
 *                               `skills/writing-style-contract/`；有意不装
 *                               `tool-web` / `tool-goal`（各带 2–3 个 schema，
 *                               是每轮都在前缀里的成本）。
 *
 * 所以自检对**两层各查一遍**：只查其中一层，另一层挂不上时报告照样说"一切正常"。
 *
 * 这条链上有几个**静默**的失败点，全都表现为"模式就是不出现（或者一进去就挂）"：
 *   1. 包没被装进 profile 的 `node_modules`（例如直接从 clone 的目录挂载），
 *      patch 根本没被读到；
 *   2. 行的 `name` 被写成 `!!js`——loader **只对 `config` 插值**，`name` 会原样
 *      丢给 `EntryTree.import()`，整行报错；
 *   3. 子行的 `name` 写成相对路径——`config.plugins` 里的名字**不享受**启动器对
 *      `insert` 名字的相对路径改写，它会按 profile 目录解析，于是找不到文件；
 *   4. 包内路径没走 `createRequire(baseUrl)`——preset 树的 `baseUrl` 是
 *      **profile 目录**，不是组合文件所在目录，写死的相对路径会指向错误的地方；
 *   5. 双引号标量里的 `\n` 被 YAML 先解析成真换行，JS 源码跨行、编译报错；
 *   6. 五个审读角色的人设文件缺失——`!!js` 读文件会抛错，整个模式挂不上。
 *
 * ── 另一半是两份技能：**随 preset 挂载**，不落用户根 ────────────────────────
 *
 * 技能根由 preset 那一行的 `customSkillDirs` 声明，指向**包内** `skills/`：
 * `short-story`（写作流程）与 `writing-style-contract`（文风契约）。于是它们注册进
 * **本 preset 那一层**——只在这个模式里可见。
 *
 * 这是**故意的**。`<DSH_HOME>/skills` 是用户根（`skill-filesystem` 里 rank 400
 * 的 `user-dsh`），而每个 preset 自己挂的 skill-filesystem 实例都会扫它
 * （`includeDefaultRoots` 默认 true）。往那儿放一份，等于让文风契约出现在所有模式
 * 里，包括编码会话——而它只属于写作模式。
 *
 * 所以本包**不安装**用户根副本（v1.0.1／v1.0.2 曾提供过一个可选的 install）。
 * 若用户根下还能找到一份，那是历史残留或用户自己写的：前者带本包的归属标记，
 * 可清；后者不归本包管。两种情况都只是**报告**，不算故障。
 *
 * ── 活体检查 ────────────────────────────────────────────────────────────────
 *
 * 上面全是**静态**判据：文件在不在、形状对不对。它们不能证明"模式真的装起来了"。
 * 所以自检在能拿到 `ctx` 时还会问运行时本身（`ctx.agentPresets`）：
 *   * roster 里有没有这两个 id，各自的 `broken` 是不是空（两个都报，按 id 分行）；
 *   * 每个 id 那一层里的技能是不是它该有的那份（`ctx.skills.list({ scope })`）；
 *   * 每个 id 那一层里有没有四个 `story_*` 工具（`ctx.tools.schemas(scope)`）。
 *
 * 0.1.7 起同一个进程里可以同时挂着多个 preset，所以"我现在跑在哪个里"必须**问**
 * 而不是**猜**：注册表的 `composedPreset(ctx)` 就是这件事的判据（它的 jsDoc：
 * "Read the preset a live Agent uses"，`@param ctx Agent context`；注册表自己的
 * 不变式检查也这么读：`presets.composedPreset(agent.ctx)`）。自检因此取工具调用
 * 上下文里的 `exec.agent.ctx`。拿不到 agent（独立调用）、服务没这个方法、或它返回
 * 空（这个 agent 没有 join 任何 preset）时，**不拿另一个 preset 顶上**——如实写
 * "未能判定"，并逐个列出两个 preset 的读数。
 *
 * 活体检查是**尽力而为**：拿不到服务、或读取超时（注册表诊断会等宿主 Loader
 * 结算，标准环境里是瞬时的，但没有理由让一次自检卡死），就如实写"未取到"，
 * 而不是把它算成通过或失败。
 *
 * @module dsh-story-mode/doctor
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTool } from './tool-kit.js'

/** Cordis 插件名。独立挂载时用它。 */
export const name = 'story-doctor'

/** 本入口不发布服务，只需要工具注册表。 */
export const inject = ['tools']

const PRESET_ID = 'short-story'
const PRESET_ROW_ID = 'preset-short-story'
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'
const STORY_TOOLS_ROW_ID = 'story-tools'
const PACKAGE_NAME = 'dsh-story-mode'
/** 文风契约与写作流程技能的名字（= 包内目录名 = SKILL.md 里的 name）。 */
const SKILL_NAMES = ['short-story', 'writing-style-contract']
/** 本包自带的四个只读工具。 */
const STORY_TOOLS = ['story_wordcount', 'story_lint', 'story_bible', 'story_doctor']
const MARKER = '.dsh-story-mode.json'
/** 五个审读角色的人设文件；组合里的每一行 `!!js` 按名字读其中一个。 */
const REVIEWER_FILE = {
  b1: 'b1-cold-read.md',
  b2: 'b2-story-logic.md',
  b3: 'b3-reading-experience.md',
  b4: 'b4-style-execution.md',
  b5: 'b5-physical-continuity.md',
}
const REVIEWER_IDS = ['b1', 'b2', 'b3', 'b4', 'b5']
/** 活体检查的单次上界；超时就报"未取到"，不卡住自检。 */
const LIVE_TIMEOUT_MS = 3000
/** 包内路径的唯一合法算法：preset 树的 baseUrl 是 profile 目录，不是包目录。 */
const PACKAGE_ANCHOR = `createRequire(baseUrl).resolve('${PACKAGE_NAME}/package.json')`
/** 写进正则里的字面量（id、包名、工具名都含 `.`、`-`、`/`）。 */
const escapeRe = (text) => text.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

/**
 * 两个模式"没它就不成立"的行（完整版那一条与 test/preset-contract.test.js 的
 * required 同源）。`command-goal` 不在里面：精简版**有意**把它也删了（`/goal`
 * 只有配上 `tool-goal` 才收得回来，只留命令会留下"目标 armed 却读不到"的坑），
 * 所以它算完整版那一层自己的行。
 *
 * 少一行不一定报错，只会静默少一项能力：没有 `present` 就没法交付稿件，没有
 * `tool-ask-user` 就没法在接稿时一次问清约束，没有 `tool-fs-search` 就只能通读
 * 改稿。所以逐个点名，而不是只查"行数不为零"。
 */
const COMMON_PRESET_ROWS = [
  'persona', 'agent-instructions',
  'tool-fs', 'tool-fs-search', 'tool-str-replace-editor', STORY_TOOLS_ROW_ID,
  'skill-filesystem', 'tool-skill',
  'compaction', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-ask-user', 'present',
]

/**
 * 两个 preset 的静态契约：一层 patch 一行声明，各自的 id、技能根、审读员与行清单。
 *
 * 这里写死的是**本包自己的形状**（和 `test/preset-contract.test.js`、
 * `scripts/verify-composition.mjs` 守着的是同一份契约）：自检的价值在于"发出去的包
 * 和验证过的包是同一个形状"，所以判据必须是常量，不能从文件里反推——反推出来的
 * 期望值永远等于现状，查不出"少了一层"。
 */
const PRESETS = [
  {
    key: 'full',
    label: '短篇小说模式',
    presetId: PRESET_ID,
    rowId: PRESET_ROW_ID,
    patchFile: 'cordis.patch.yml',
    order: 5,
    /** `customSkillDirs` 必须声明的技能根（包内相对路径）。 */
    skillRoots: ['skills'],
    /**
     * 必须存在且**非空**的包内文件。缺文件会让 `!!js` 读不到、整行 config 无效、
     * preset 直接变 broken；空文件更隐蔽：行挂得上，但人设或流程是空的。
     */
    fileChecks: [
      { label: '包内 skills/short-story/', paths: ['skills/short-story/SKILL.md'], missing: '包内缺少 skills/short-story/SKILL.md' },
      { label: '共用写作流程（references/）', paths: ['skills/short-story/references/writing-workflow.md'], missing: '包内缺少写作技能的 references/writing-workflow.md（共用写作流程）' },
      { label: '审读面板（references/）', paths: ['skills/short-story/references/review-panel.md'], missing: '包内缺少写作技能的 references/review-panel.md（审读面板派发说明书）' },
      { label: '包内 skills/writing-style-contract/', paths: ['skills/writing-style-contract/SKILL.md'], missing: '包内缺少 skills/writing-style-contract/SKILL.md' },
      {
        label: '角色人设文件（references/reviewers/）',
        paths: REVIEWER_IDS.map((role) => `skills/short-story/references/reviewers/${REVIEWER_FILE[role]}`),
        missing: '包内缺少审读角色人设文件（references/reviewers/*.md）',
      },
    ],
    /** 五位角色化审读员：工具名 + 人设文件（组合里的路径写法即 file 的尾部）。 */
    reviewers: REVIEWER_IDS.map((role) => ({
      key: role,
      tool: `subagent_review_${role}`,
      file: `skills/short-story/references/reviewers/${REVIEWER_FILE[role]}`,
      /** persona 表达式里必须出现的片段（组合里是整条角色路径）。 */
      personaTokens: [`reviewers/${REVIEWER_FILE[role]}`],
    })),
    /** 只有本模式必须有的行（其余见 COMMON_PRESET_ROWS）。 */
    extraRows: ['command-goal', 'tool-goal', 'tool-web', ...REVIEWER_IDS.map((role) => `tool-subagent-review-${role}`)],
    /** 有意**不**装的行：出现了说明这一层的取舍被改过，报告要指出来。 */
    absentRows: [],
    /** 审读员的 toolFilter.allow 原文（只读边界就在这里）。 */
    reviewerAllow: 'allow: [read, read_image, str_replace_editor, glob, grep]',
    /** 活体检查期望在本作用域里看到的技能名。 */
    liveSkills: SKILL_NAMES,
  },
  {
    key: 'lite',
    label: '短篇小说模式（精简）',
    presetId: 'short-story-lite',
    rowId: 'preset-short-story-lite',
    patchFile: 'cordis.lite.patch.yml',
    order: 6,
    // 两个技能根：精简流程技能目录，以及**契约目录本身**（skill-filesystem 扫根时
    // 目录取 `<目录>/SKILL.md`，所以指向 `skills/writing-style-contract/` 就能把
    // 契约单独挂进来，不必连带完整版那份 6,546 字符的面板）。
    skillRoots: ['skills-lite', 'skills/writing-style-contract'],
    fileChecks: [
      { label: '技能正文 skills-lite/short-story-lite/SKILL.md', paths: ['skills-lite/short-story-lite/SKILL.md'], missing: '包内缺少 skills-lite/short-story-lite/SKILL.md（精简流程技能）' },
      { label: '共用文风契约 skills/writing-style-contract/SKILL.md', paths: ['skills/writing-style-contract/SKILL.md'], missing: '包内缺少 skills/writing-style-contract/SKILL.md（精简版把它单挂一个根）' },
      { label: '合并审读员人设 skills-lite/references/reviewer-merged.md', paths: ['skills-lite/references/reviewer-merged.md'], missing: '包内缺少 skills-lite/references/reviewer-merged.md（唯一一位审读员的人设）' },
    ],
    reviewers: [{
      key: 'merged',
      tool: 'subagent_review',
      file: 'skills-lite/references/reviewer-merged.md',
      // persona = 角色文件 + **换行** + 文风契约全文。换行只能写
      // `String.fromCharCode(10)`：双引号标量里的 `\n` 会被 YAML 先变成真换行，
      // JS 源码跨行、整行编译失败（v1.1.3 的事故）。
      personaTokens: ['reviewer-merged.md', "'writing-style-contract'", "'SKILL.md'", 'String.fromCharCode(10)'],
    }],
    extraRows: ['tool-subagent-review'],
    // 精简版有意砍掉的两行：`tool-web`（2 个工具）与 `tool-goal`（3 个工具）
    // 是每轮都在前缀里的成本；`command-goal` 保留——斜杠命令不进工具面。
    absentRows: ['tool-web', 'tool-goal'],
    // 不含 `str_replace_editor`：精简版的审读员是**真的**只读（它的命令是
    // view/create/str_replace/insert），而且省下 2,803 字符的 schema。
    reviewerAllow: 'allow: [read, read_image, glob, grep]',
    liveSkills: ['short-story-lite', 'writing-style-contract'],
  },
]
const PRESET_IDS = PRESETS.map((preset) => preset.presetId)

/** 解析 harness 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return resolvePath(configured)
  return join(homedir(), '.dsh')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 文件在不在、有没有正文。
 *
 * 组合里的 `!!js` 是**读文件**的：文件缺失会抛错、整行 config 无效、preset 直接
 * 变 broken。空文件更隐蔽——行挂得上，但人设或流程是空的。两种都要分开报。
 */
async function readNonEmpty(path) {
  const raw = await readIfPresent(path)
  if (raw === null) return { present: false, empty: false }
  return { present: true, empty: raw.trim().length === 0 }
}

/** 这个包的真实目录（lib/ 的上一级）。 */
function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * 本包是不是装在某个 profile 的 `node_modules` 下。
 *
 * 这一条决定模式归谁管：装在那儿，`dsh plugin add` 之后 patch 自动生效；
 * 否则（从 clone 的目录直接挂载）不会有 patch 生效，模式永远不会出现。
 *
 * 不能用 `import.meta.url` 判断：profile 里那一份往往是**符号链接**（`link:` 或
 * pnpm 的 store 链接），而 Node 的 ESM loader 对 `import.meta.url` 做的是
 * realpath——于是真实的开发目录会被当成"不在 profile 下"，自检误报。
 * 所以改从 `<DSH_HOME>/profiles/<name>/node_modules/dsh-story-mode` 直接找入口，
 * 按**安装点**判断，而不是按模块自己的真实路径。
 */
async function findProfileInstall(home) {
  const profilesRoot = join(home, 'profiles')
  let profiles
  try {
    profiles = await readdir(profilesRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const installed = join(profilesRoot, entry.name, 'node_modules', PACKAGE_NAME)
    if (!(await exists(join(installed, 'package.json')))) continue
    // 只认真的导出 apply 的那一份；目录里躺着别的同名东西时不要误判。
    return { profile: entry.name, installed }
  }
  return null
}

/**
 * 静态分析一层 patch。
 *
 * 判据只针对**形状**：插入了哪一行、子行的名字是哪种写法、包内路径怎么算出来的。
 * 每一条都对应一个真实踩过的失败模式（见文件头）。`preset` 决定查哪一层的 id、
 * 哪一位审读员：同一个函数查两层，两层就受同一套判据保护。
 */
function analysePatch(raw, preset) {
  // 文件读不到：形状判据全按"否"记，必需行按"一行都没有"记。渲染器逐项读这些
  // 字段，缺一个就会在**最该被看清的那种故障**（整层 patch 不在）上抛错。
  if (raw === null) {
    return {
      present: false,
      hasInsert: false,
      presetRow: false,
      presetPlugin: false,
      presetId: false,
      configName: null,
      orderValue: null,
      bareToolsRow: false,
      jsRowNames: [],
      relativeRowNames: [],
      resolvesPackage: false,
      pathReadCount: 0,
      unanchoredPathReads: [],
      riskyScalars: [],
      hasLineComment: false,
      customSkillDirs: false,
      declaredSkillRoots: [],
      missingRows: [...COMMON_PRESET_ROWS, ...preset.extraRows],
      unexpectedRows: [],
      reviewerRows: {},
      reusable: false,
    }
  }
  const hasInsert = /^-\s*insert:\s*$/m.test(raw)
  const presetRow = new RegExp(`^\\s*-\\s*id:\\s*${escapeRe(preset.rowId)}\\s*$`, 'm').test(raw)
  const presetPlugin = new RegExp(`^\\s*name:\\s*'?${escapeRe(PRESET_PLUGIN)}'?\\s*$`, 'm').test(raw)
  const presetId = new RegExp(`^\\s*id:\\s*${escapeRe(preset.presetId)}\\s*$`, 'm').test(raw)
  // 子插件行的名字必须是裸包名：`insert` 之外的名字不会被启动器改写，相对路径会按
  // profile 目录解析；`!!js` 名字根本不会被插值。两种都能让整行 import 失败。
  const bareToolsRow = new RegExp(`-\\s*id:\\s*${STORY_TOOLS_ROW_ID}\\s*\\n\\s*name:\\s*${PACKAGE_NAME}\\s*$`, 'm').test(raw)
  const jsRowNames = [...raw.matchAll(/^[ \t]*name:\s*!!js/gm)].map((m) => m[0])
  const relativeRowNames = [...raw.matchAll(/^[ \t]*name:\s*(\.\.?\/[^\s]*)/gm)].map((m) => m[1])
  // 包内路径必须由 createRequire(baseUrl) 在运行时问出来：preset 树的 baseUrl 是
  // profile 目录，写死的相对路径会指向 profile，而不是包。
  const resolvesPackage = raw.includes(PACKAGE_ANCHOR)
  const jsExprs = [...raw.matchAll(/!!js\s+"([^"]*)"/g)].map((m) => m[1])
  // 判据是"表达式提到了包内的目录/文件名"，不是某个特定拼法：精简版把
  // `skills/writing-style-contract` 写成 `'skills', 'writing-style-contract'`，
  // 按 `skills/` 这种字面量找会一个都找不到——锚点检查就变成永远通过。
  const pathExprs = jsExprs.filter((expr) => /(['"])(?:skills-lite|skills|lib|bin)\1/.test(expr)
    || /(?:skills-lite|skills)\//.test(expr)
    || /\.md['"]/.test(expr)
    || expr.includes(PACKAGE_NAME))
  const unanchoredPathReads = pathExprs.filter((expr) => !expr.includes(PACKAGE_ANCHOR))
  // 双引号标量里的反斜杠转义会被 YAML 先处理掉：`'\n'` 会变成真换行，JS 源码跨行。
  // v1.1.3 正是栽在这里，所以单列一项。
  const riskyScalars = [...raw.matchAll(/!!js[ \t]+"[^"\n]*\\[^"\n]*"/g)].map((m) => m[0].slice(0, 60))
  // 折叠标量（`!!js >-`）会被压成一行，一个 `//` 注释就能吃掉后面全部代码。
  const foldedAt = raw.indexOf('!!js >-')
  const hasLineComment = foldedAt >= 0
    && raw.slice(foldedAt + '!!js >-'.length).split(/\r?\n/).some((line) => /(^|\s)\/\//.test(line))
  const customSkillDirs = raw.includes('customSkillDirs:')
  // preset 行 config 里的 name/order：`config.id` 那一行到 `plugins:` 之间就是。
  // （不用整份文件里的第一个 `order:`：别的行也可能有同名键，取错了会把形状问题
  // 说成数值问题。）
  const lines = raw.split(/\r?\n/)
  const idLine = lines.findIndex((line) => new RegExp(`^\\s*id:\\s*${escapeRe(preset.presetId)}\\s*$`).test(line))
  let configName = null
  let orderValue = null
  if (idLine >= 0) {
    const indent = lines[idLine].length - lines[idLine].trimStart().length
    for (let i = idLine + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      if (line.length - line.trimStart().length < indent) break
      if (/^\s*plugins:\s*$/.test(line)) break
      const nameHit = line.match(/^\s*name:\s*(.+?)\s*$/)
      if (nameHit !== null && configName === null) configName = nameHit[1].replace(/^['"]|['"]$/g, '')
      const orderHit = line.match(/^\s*order:\s*(\S+)\s*$/)
      if (orderHit !== null && orderValue === null) orderValue = orderHit[1]
    }
  }
  return {
    present: true,
    hasInsert,
    presetRow,
    presetPlugin,
    presetId,
    configName,
    orderValue,
    bareToolsRow,
    jsRowNames,
    relativeRowNames,
    resolvesPackage,
    pathReadCount: pathExprs.length,
    unanchoredPathReads,
    riskyScalars,
    hasLineComment,
    customSkillDirs,
    declaredSkillRoots: declaredSkillRoots(raw),
    missingRows: [...COMMON_PRESET_ROWS, ...preset.extraRows]
      .filter((row) => !new RegExp(`^\\s*-\\s*id:\\s*${escapeRe(row)}\\s*$`, 'm').test(raw)),
    unexpectedRows: preset.absentRows
      .filter((row) => new RegExp(`^\\s*-\\s*id:\\s*${escapeRe(row)}\\s*$`, 'm').test(raw)),
    reviewerRows: Object.fromEntries(preset.reviewers.map((reviewer) => {
      const expr = personaExpr(raw, reviewer.tool)
      return [reviewer.key, {
        toolName: new RegExp(`^\\s*toolName:\\s*${escapeRe(reviewer.tool)}\\s*$`, 'm').test(raw),
        persona: expr !== null && reviewer.personaTokens.every((token) => expr.includes(token)),
        readOnly: raw.includes(preset.reviewerAllow),
        deniesWrites: raw.includes('deny: [write, edit, present,'),
      }]
    })),
    reusable: raw.includes('backgroundMode: continuable') && raw.includes("'@deepseek-ai/dsh-tool-subagent-control'"),
  }
}

/**
 * 一位审读员的 persona 表达式：`toolName: <tool>` 那一行之后第一个 `persona: !!js "…"`。
 *
 * 在表达式**里面**找判据，而不是在整份文件里搜路径：`persona` 的路径写法和
 * `customSkillDirs` 不一样（一个是整条 `'skills/.../b1-cold-read.md'`，另一个是
 * `'skills-lite', 'references', 'reviewer-merged.md'`），而且注释里也会出现这些词。
 */
function personaExpr(raw, tool) {
  const at = raw.search(new RegExp(`^\\s*toolName:\\s*${escapeRe(tool)}\\s*$`, 'm'))
  if (at < 0) return null
  const match = raw.slice(at).match(/persona:\s*!!js\s+"([^"]*)"/)
  return match === null ? null : match[1]
}

/**
 * patch 里声明的技能根（`customSkillDirs` 的 `!!js` 表达式 → 包内相对路径）。
 *
 * 表达式形如
 * `join(dirname(createRequire(baseUrl).resolve('dsh-story-mode/package.json')), 'skills-lite')`：
 * 锚点之后的字符串字面量就是路径分段。取分段而不是在整份文件里搜 `skills-lite`
 * 这个词，是因为**注释里也会出现这个词**——搜词会把注释当成配置。
 */
function declaredSkillRoots(raw) {
  const roots = []
  for (const match of raw.matchAll(/^[ \t]*-[ \t]*!!js[ \t]+"([^"]*)"[ \t]*$/gm)) {
    const segments = [...match[1].matchAll(/'([^']*)'/g)].map((segment) => segment[1])
    const anchor = segments.indexOf(`${PACKAGE_NAME}/package.json`)
    if (anchor < 0) continue
    const rest = segments.slice(anchor + 1)
    if (rest.length > 0) roots.push(rest.join('/'))
  }
  return roots
}

/**
 * 用户选定的默认预设。
 *
 * 0.1.7 起默认值有两个来源：部署的 `agent-preset-registry` 行 `config.default`，
 * 以及**用户**选择覆盖的 volatile 字段 `config.selectedDefault`。注册表读的是
 * `defaultId = selectedDefault ?? default`（`selectedDefault` 是 volatile 的，
 * 由 loader 写回它所在的那一层——profile 的 `cordis.patch.yml`，Web 配置编辑器
 * 也写在这里；偶尔还会出现在 profile 根配置的转储里）。所以静态检查要扫这几个
 * 位置，并且在**同一条目里先看 `selectedDefault`**：反过来的话，`default: standard`
 * 写在 `selectedDefault: short-story-lite` 前面时，报告会拿到 `standard` 并声称
 * "卸载安全"——而真正会变成悬空 id 的是后面那个。
 *
 * 为什么单列一项：本模式（两个 id 中任意一个）被设成默认之后再卸载包，新建会话
 * 会直接以 `agent-preset/not-found` 失败——注册表的 `resolve()`／`retain()` 找不到
 * 默认 id 时**不回退**到 `standard`，而会顺手清掉这个默认值的那条路径被
 * `dsh plugin remove` 绕过了。这是唯一一处"卸载后无法自救"的故障。
 *
 * 兜底还认 v1.0.x 时代 `<DSH_HOME>/settings.yaml` 里的 `agent-presets:` 块。
 */
async function readDefaultPreset(home, install) {
  const sources = []
  sources.push({ label: 'settings.yaml（旧位置）', raw: await readIfPresent(join(home, 'settings.yaml')), kind: 'settings' })
  if (install !== null) {
    const profileDir = join(home, 'profiles', install.profile)
    sources.push({ label: `${install.profile}/cordis.patch.yml`, raw: await readIfPresent(join(profileDir, 'cordis.patch.yml')), kind: 'patch' })
    sources.push({ label: `${install.profile}/cordis.yml`, raw: await readIfPresent(join(profileDir, 'cordis.yml')), kind: 'patch' })
  }
  sources.push({ label: 'cordis.patch.yml（home 层）', raw: await readIfPresent(join(home, 'cordis.patch.yml')), kind: 'patch' })

  for (const source of sources) {
    if (source.raw === null) continue
    if (source.kind === 'patch') {
      const id = readPatchDefault(source.raw)
      if (id !== null) return { id, source: source.label }
      continue
    }
    const lines = source.raw.split(/\r?\n/)
    const start = lines.findIndex((line) => /^agent-presets:\s*$/.test(line))
    if (start < 0) continue
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      if (/^\S/.test(line)) break
      const match = line.match(/^\s+default:\s*(.*?)\s*$/)
      if (match !== null) {
        const value = match[1].replace(/^['"]|['"]$/g, '')
        if (value.length > 0) return { id: value, source: source.label }
      }
    }
  }
  return null
}

/**
 * 一份 patch 里的"有效默认模式"：先看 `agent-preset-registry` 那一条目，条目里
 * 先看 `selectedDefault`（用户的选择覆盖部署默认），再退回整份文件里的这两个字段。
 *
 * 条目形状的判据与 `scripts/cleanup.mjs` 的 `findDefaultPresetLine()` 一致：
 * 只有落在注册表条目里的取值才算默认值，别的行上的同名键（例如某个工具插件自己的
 * `default:`）不是。这一条必须和清理脚本一致——自检说"安全"而清理脚本说"要清"，
 * 用户就不知道该信谁。
 */
function readPatchDefault(raw) {
  const scoped = readRegistryField(raw, 'selectedDefault') ?? readRegistryField(raw, 'default')
  if (scoped !== null) return scoped
  return raw.match(/^\s*selectedDefault:\s*['"]?([\w-]+)['"]?\s*$/m)?.[1]
    ?? raw.match(/^\s*default:\s*['"]?([\w-]+)['"]?\s*$/m)?.[1]
    ?? null
}

/** 注册表条目里的一个字段值。 */
function readRegistryField(raw, field) {
  let inRegistry = false
  for (const line of raw.split(/\r?\n/)) {
    const rowMatch = line.match(/^-\s*id:\s*(\S+)\s*$/)
    if (rowMatch !== null) {
      inRegistry = rowMatch[1] === 'agent-preset-registry'
      continue
    }
    if (!inRegistry) continue
    const match = line.match(new RegExp(`^\\s+${field}:\\s*(.*?)\\s*$`))
    if (match === null) continue
    const value = match[1].replace(/^['"]|['"]$/g, '')
    if (value.length > 0) return value
  }
  return null
}

/** profile 的 patch 层覆盖了哪些 preset 行（用户改过组合）。两个 id 各查一次。 */
async function readOverrides(home, install) {
  if (install === null) return null
  const raw = await readIfPresent(join(home, 'profiles', install.profile, 'cordis.patch.yml'))
  if (raw === null) return null
  const rowIds = PRESETS
    .map((preset) => preset.rowId)
    .filter((rowId) => new RegExp(`^\\s*-\\s*id:\\s*${escapeRe(rowId)}\\s*$`, 'm').test(raw))
  return rowIds.length === 0 ? null : { file: `${install.profile}/cordis.patch.yml`, rowIds }
}

/** 在 `ms` 内等待；超时返回哨兵，不抛出。 */
const TIMEOUT = Symbol('timeout')
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(TIMEOUT), ms)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
}

/**
 * 问运行时本身：两个模式真的装起来了吗？本工具又跑在哪一个里？
 *
 * 全部尽力而为：服务不可见、调用抛错、超时，都只记状态，不算故障。
 *
 * 每个 preset 一份读数（`presets[<id>]`：roster 行 + 组合清单 + 它那一层的技能与
 * 工具），"当前所在"单独一项（`running`）。**不拿"另一个 preset 很健康"顶替
 * "这一个装没装起来"**：0.1.7 起同一进程里可以同时挂着多个 preset，判错方向是
 * 静默的——在精简版会话里报完整版的健康状况，两边都看不出来。
 */
async function probeLive(ctx, agentCtx) {
  if (ctx === undefined || typeof ctx.get !== 'function') return { status: 'unavailable', reason: '没有 ctx（独立调用）' }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return { status: 'unavailable', reason: 'agentPresets 服务不可见' }
  const result = {
    status: 'ok',
    presets: Object.fromEntries(PRESETS.map((preset) => [preset.presetId, {}])),
    running: detectRunningPreset(presets, agentCtx),
  }

  // roster 与组合清单各只问一次：两个 preset 的读数都从这两份结果里挑。
  let roster = null
  let rosterState = null
  try {
    const read = await withTimeout(presets.remoteExportList(), LIVE_TIMEOUT_MS)
    if (read === TIMEOUT) rosterState = { status: 'timeout' }
    else {
      roster = read.presets
      result.rosterIds = roster.map((preset) => preset.id)
    }
  } catch (error) {
    rosterState = { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
  let inventory = null
  let inventoryState = null
  try {
    const read = await withTimeout(presets.compositionInventory(), LIVE_TIMEOUT_MS)
    if (read === TIMEOUT) inventoryState = { status: 'timeout' }
    else inventory = read
  } catch (error) {
    inventoryState = { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }

  for (const preset of PRESETS) {
    const row = roster?.find((entry) => entry.id === preset.presetId)
    const mine = inventory?.find((entry) => entry.id === preset.presetId)
    result.presets[preset.presetId] = {
      roster: rosterState ?? (row === undefined
        ? { status: 'missing' }
        : { status: 'ok', isDefault: row.isDefault === true, name: row.name ?? null, order: row.order ?? null }),
      composition: inventoryState ?? (mine === undefined
        ? { status: 'missing' }
        : {
            status: 'ok',
            broken: mine.broken ?? null,
            rows: mine.rows.length,
            active: mine.rows.filter((entry) => String(entry.fiberState) === '2').length,
          }),
    }
  }

  // 作用域读数：两个 preset 都探——judged by id，不猜"哪个是本模式"。只有它确实
  // 挂起来（roster 里有、没判 broken）才 acquireScope：挂不上的那一层 retain()
  // 会以 agent-preset/invalid 抛错，探出来的只会是错误。
  for (const preset of PRESETS) {
    const state = result.presets[preset.presetId]
    if (state.composition?.status !== 'ok' || state.composition.broken !== null) {
      state.scope = { status: 'skipped' }
      continue
    }
    state.scope = await probeScope(ctx, presets, preset)
  }
  return result
}

/**
 * 本工具跑在哪个 preset 里？
 *
 * 判据只有注册表的 `composedPreset(ctx)`（jsDoc："Read the preset a live Agent
 * uses"，`@param ctx Agent context`；注册表自己的不变式检查也这么读：
 * `presets.composedPreset(agent.ctx)`）。拿不到 agent ctx、服务没这个方法、抛错、
 * 或返回空，都记成 `undetermined` 并在报告里写明原因——**不退回**"那就当它在完整版
 * 里"：这种猜测在精简版会话里会给出另一层的读数，而报告看起来一切正常。
 */
function detectRunningPreset(presets, agentCtx) {
  if (agentCtx === undefined || agentCtx === null) {
    return { status: 'undetermined', reason: '本次调用没有 agent ctx（工具不在会话里跑）' }
  }
  if (typeof presets.composedPreset !== 'function') {
    return { status: 'undetermined', reason: 'agentPresets.composedPreset 不可用（harness 版本不同？）' }
  }
  try {
    const id = presets.composedPreset(agentCtx)
    if (typeof id === 'string' && id.length > 0) return { status: 'ok', presetId: id }
    return { status: 'undetermined', reason: 'composedPreset 返回空（这个 agent 没有绑定 preset）' }
  } catch (error) {
    return { status: 'undetermined', reason: `composedPreset 抛错：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 一个 preset 那一层里的技能与工具（`acquireScope` 的租约用完即还）。 */
async function probeScope(ctx, presets, preset) {
  try {
    const lease = await withTimeout(presets.acquireScope(preset.presetId), LIVE_TIMEOUT_MS)
    if (lease === TIMEOUT) return { status: 'timeout' }
    try {
      const scope = { status: 'ok' }
      const skills = ctx.get('skills')
      const list = skills === undefined ? undefined : await withTimeout(skills.list({ scope: lease.key }), LIVE_TIMEOUT_MS)
      scope.skills = list === undefined || list === TIMEOUT
        ? { status: list === TIMEOUT ? 'timeout' : 'unavailable' }
        : { status: 'ok', names: list.map((skill) => skill.name) }
      const tools = ctx.get('tools')
      if (tools === undefined) scope.tools = { status: 'unavailable' }
      else {
        const names = tools.schemas(lease.key).map((tool) => tool.name)
        scope.tools = { status: 'ok', names: names.filter((tool) => tool.startsWith('story_')) }
      }
      return scope
    } finally {
      await lease[Symbol.asyncDispose]().catch(() => {})
    }
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 跑完整套自检。`ctx` 可选：给了就顺带做活体检查；`agentCtx` 用来判定当前所在 preset。 */
export async function runDoctor(ctx, agentCtx) {
  const root = packageRoot()
  const home = dshHome()

  let version = 'unknown'
  try {
    version = JSON.parse((await readIfPresent(join(root, 'package.json'))) ?? '{}').version ?? 'unknown'
  } catch {
    // 版本只用于展示
  }

  // 包自己的 package.json 必须是无 BOM 的合法 JSON——带 BOM 会让 DSH 读不出
  // `dsh.bundle` 声明，于是包不会被加进 profile 的 bundles，patch 永远不生效。
  const ownManifestRaw = await readIfPresent(join(root, 'package.json'))
  let manifest = { parses: false, declaresBundle: false, filesIncludeSkills: false, hasBom: false }
  if (ownManifestRaw !== null) {
    manifest.hasBom = ownManifestRaw.charCodeAt(0) === 0xFEFF
    try {
      const parsed = JSON.parse(ownManifestRaw.replace(/^\uFEFF/, ''))
      // `dsh.bundle.patch` 是路径数组（`bundlePatchFiles()` 也接受单个字符串）：
      // 少写一个文件，那一层 preset 就不会被读到，而模式选择器里看不出区别。
      const declared = parsed.dsh?.bundle?.patch
      manifest = {
        parses: true,
        hasBom: manifest.hasBom,
        declaresBundle: declared !== undefined,
        patchFiles: Array.isArray(declared) ? declared : (typeof declared === 'string' ? [declared] : undefined),
        filesIncludeSkills: Array.isArray(parsed.files) && parsed.files.includes('skills'),
        filesIncludeSkillsLite: Array.isArray(parsed.files) && parsed.files.includes('skills-lite'),
      }
    } catch {
      manifest.parses = false
    }
  }

  // 两层 patch 各查一遍：只查一层，另一层挂不上时报告照样说"一切正常"。
  const presetReports = []
  for (const preset of PRESETS) {
    const patch = analysePatch(await readIfPresent(join(root, preset.patchFile)), preset)
    const fileChecks = []
    for (const check of preset.fileChecks) {
      const states = {}
      for (const path of check.paths) states[path] = await readNonEmpty(join(root, ...path.split('/')))
      fileChecks.push({ label: check.label, missing: check.missing, paths: check.paths, states })
    }
    presetReports.push({
      key: preset.key,
      label: preset.label,
      presetId: preset.presetId,
      rowId: preset.rowId,
      patchFile: preset.patchFile,
      expectedOrder: preset.order,
      liveSkills: preset.liveSkills,
      patch,
      skillRoots: preset.skillRoots,
      absentRows: preset.absentRows,
      expectedRows: COMMON_PRESET_ROWS.length + preset.extraRows.length,
      fileChecks,
      reviewersOk: preset.reviewers.every((reviewer) => {
        const row = patch.reviewerRows?.[reviewer.key]
        return row !== undefined && row.toolName && row.persona && row.readOnly && row.deniesWrites
      }),
      reviewerCount: preset.reviewers.length,
    })
  }
  // 旧路径（renderDoctor 的单 preset 形状）继续读这一份：报告对象是导出的 API。
  const patch = presetReports[0].patch

  const install = await findProfileInstall(home)
  const viaProfile = install !== null

  let profileState = { present: false, bundled: false, resolvable: false }
  if (install !== null) {
    const profileDir = join(home, 'profiles', install.profile)
    const profilePkg = await readIfPresent(join(profileDir, 'package.json'))
    let bundles = []
    try {
      bundles = JSON.parse(profilePkg ?? '{}').dsh?.profile?.bundles ?? []
    } catch {
      bundles = []
    }
    const overrides = await readOverrides(home, install)
    profileState = {
      present: true,
      profile: install.profile,
      installedAt: install.installed,
      bundled: bundles.includes(PACKAGE_NAME),
      // 子行的裸包名要靠 profile 的 node_modules 解析：这正是 `story-tools` 那一行
      // 能加载的前提。
      resolvable: await exists(join(install.installed, 'package.json')),
      overrides,
      override: overrides !== null && overrides.rowIds.includes(PRESET_ROW_ID) ? overrides.file : null,
    }
  }

  const packageFiles = {
    libEntry: await exists(join(root, 'lib', 'index.js')),
    flowSkill: await exists(join(root, 'skills', 'short-story', 'SKILL.md')),
    workflow: await exists(join(root, 'skills', 'short-story', 'references', 'writing-workflow.md')),
    panel: await exists(join(root, 'skills', 'short-story', 'references', 'review-panel.md')),
    contract: await exists(join(root, 'skills', 'writing-style-contract', 'SKILL.md')),
    reviewers: Object.fromEntries(await Promise.all(REVIEWER_IDS.map(async (role) => [
      role,
      await exists(join(root, 'skills', 'short-story', 'references', 'reviewers', REVIEWER_FILE[role])),
    ]))),
  }
  const reviewersComplete = REVIEWER_IDS.every((role) => packageFiles.reviewers[role])
  const reviewersRoleBased = REVIEWER_IDS.every((role) => {
    const row = patch.reviewerRows?.[role]
    return row !== undefined && row.toolName && row.persona && row.readOnly && row.deniesWrites
  })

  // 用户根下的文风契约副本。本包**不安装**它（理由见文件头），所以这里只报
  // 事实与后果，不算故障：带本包标记的是历史残留，可清；其余是用户自己的东西。
  const skillDest = join(home, 'skills', 'writing-style-contract')
  const skill = { dest: skillDest, present: false, owned: false, markerVersion: null }
  if (await exists(skillDest)) {
    skill.present = true
    const marker = JSON.parse((await readIfPresent(join(skillDest, MARKER))) ?? 'null')
    skill.owned = marker?.package === PACKAGE_NAME
    skill.markerVersion = marker?.version ?? null
  }

  // 旧安装残留：用户根下的同名模式目录（v1.0.1 的形态）。
  const legacyRoot = join(home, '.agent-presets')
  let legacyEntry
  try {
    legacyEntry = (await readdir(legacyRoot, { withFileTypes: true })).find((c) => c.name === PRESET_ID)
  } catch {
    legacyEntry = undefined
  }
  let legacy = { present: false }
  if (legacyEntry !== undefined) {
    const legacyDest = join(legacyRoot, PRESET_ID)
    const marker = JSON.parse((await readIfPresent(join(legacyDest, MARKER))) ?? 'null')
    legacy = {
      present: true,
      path: legacyDest,
      ours: marker?.package === PACKAGE_NAME,
      isLink: legacyEntry.isSymbolicLink(),
    }
  }

  const live = await probeLive(ctx, agentCtx)
  const defaultPreset = await readDefaultPreset(home, install)

  return {
    root,
    home,
    version,
    patch,
    presets: presetReports,
    manifest,
    packageFiles,
    reviewersComplete,
    reviewersRoleBased,
    viaProfile,
    profileState,
    skill,
    legacy,
    live,
    defaultPreset,
    cleanup: join(root, 'scripts', 'cleanup.mjs'),
  }
}

/** 活体检查里每一项的展示文案。 */
const LIVE_LABEL = {
  ok: '是',
  missing: '**否**',
  timeout: '未取到（超时）',
  unavailable: '未取到',
  error: '未取到（报错）',
  // 这一层没挂起来（roster 里没有、或已判 broken）：不 acquireScope，因为
  // 挂不上的那一层 retain() 只会抛 agent-preset/invalid。
  skipped: '未探测（这一层没挂起来，见上面的 broken 行）',
}

function liveCell(section, render) {
  if (section === undefined) return '未取到'
  return LIVE_LABEL[section.status] ?? section.status
}

/** 渲染报告。只报事实与修法，不替用户下"应该没问题"的结论。 */
export function renderDoctor(report) {
  const problems = []
  const lines = [
    '# dsh-story-mode 安装自检',
    '',
    `- 包目录：\`${report.root}\``,
    `- 包版本：${report.version}`,
    `- harness 主目录：\`${report.home}\``,
    '',
  ]

  // 第一节分两种形状：新的报告对象带 `presets`（两个模式各一份静态分析），
  // 旧形状只有一个 `patch`。旧路径保持逐字不变——`renderDoctor` 是导出的 API，
  // 手工构造的报告（以及守着这些行的契约测试）仍然长那样。
  if (Array.isArray(report.presets)) renderPresetSection(report, lines, problems)
  else renderSinglePresetSection(report, lines, problems)

  // ── 技能 ──────────────────────────────────────────────────────────────────
  lines.push('## 二、两份技能（随 preset 挂载，不落用户根）', '')
  if (!report.skill.present) {
    lines.push('- 用户根下没有副本——**这是本包的设计**：两份技能只在短篇小说模式里可见。')
    lines.push('  它们由 preset 那一行的 `customSkillDirs` 从包内挂载（见第一节的挂载检查）。')
  } else if (report.skill.owned) {
    lines.push(`- \`${report.skill.dest}\` 是**本包 v1.0.1／v1.0.2 留下的副本**（v${report.skill.markerVersion ?? '?'}）。`)
    lines.push('  它会让文风契约出现在**所有模式**里（那是用户根，每个 preset 都会扫）。')
    lines.push('  只想让它在写作模式生效的话，跑一次清理脚本即可；这不是故障，只是残留。')
  } else {
    lines.push(`- \`${report.skill.dest}\` 存在且**不是本包放的** → 本包不碰它。`)
    lines.push('  注意它同样会让这个技能出现在所有模式里；是删是留由你决定。')
  }
  lines.push('')

  // ── 卸载前要注意的 ────────────────────────────────────────────────────────
  // 默认值只认 preset **id**，所以两个 id 都要算"本模式"：只比对一个，用户把
  // 另一个设成默认时报告会说"卸载安全"——而那是唯一一处卸载后无法自救的故障。
  //
  // 旧形状（单 preset 的扁平读数）只有一个 `isDefault`，且**不带 id**：那种报告
  // 里不写 id，只报事实（"默认指向本模式"），免得替它认领一个它没说的 id。
  const flatLive = report.live?.status === 'ok' && report.live.presets === undefined
  const liveRows = liveDefaultRows(report.live)
  const liveDefaultIds = flatLive
    ? []
    : PRESET_IDS.filter((id) => liveRows[id]?.status === 'ok' && liveRows[id].isDefault === true)
  const liveDefault = flatLive
    ? (report.live.roster?.status === 'ok' ? report.live.roster.isDefault === true : undefined)
    : (liveDefaultIds.length > 0
        ? true
        : (PRESET_IDS.every((id) => liveRows[id]?.status === 'ok') ? false : undefined))
  const staticDefault = report.defaultPreset
  const staticIsThisMode = staticDefault !== null && PRESET_IDS.includes(staticDefault.id)
  lines.push('## 三、卸载前要注意的', '')
  if (liveDefault === true || (liveDefault === undefined && staticIsThisMode)) {
    const named = liveDefaultIds.length > 0 ? liveDefaultIds : (staticIsThisMode ? [staticDefault.id] : [])
    lines.push(`**你的默认模式就是本模式${named.length === 0 ? '' : `（\`${named.join('`、`')}\`）`}。** 卸载包之前必须先清掉这个默认值——`)
    lines.push('否则新建会话（不带显式 preset）会直接以 `agent-preset/not-found` 失败。')
    lines.push('注册表找不到默认 id 时不会回退，而卸载又绕过了会顺手清掉它的那条路径。')
    lines.push('所以这一步必须在 `dsh plugin remove` **之前**做：')
    lines.push('')
    lines.push('```sh')
    lines.push('dsh plugin --profile <name> exec dsh-story-mode cleanup')
    lines.push('```')
    problems.push(named.length === 0
      ? '默认预设指向本模式，卸载前必须先清理'
      : `默认预设（${named.map((id) => `\`${id}\``).join('、')}）指向本模式，卸载前必须先清理`)
  } else if (liveDefault === false || staticDefault === null) {
    lines.push('- 默认模式不是本模式，卸载安全。')
  } else {
    lines.push(`- 默认模式是 \`${staticDefault.id}\`（来自 ${staticDefault.source}），不是本模式，卸载安全。`)
  }

  if (!report.legacy.present) {
    lines.push('- 用户根下没有旧模式副本，干净。')
  } else if (report.legacy.ours) {
    lines.push(`- \`${report.legacy.path}\` 是本包**早期版本**留下的副本 → 和现在的声明同名，`)
    lines.push('  旧版本 DSH 可能解析到过期的那一份。跑一次清理脚本即可。')
    problems.push('存在旧安装的模式副本')
  } else if (report.legacy.isLink) {
    lines.push(`- \`${report.legacy.path}\` 是符号链接，且不是本包当前的形态 → 建议清掉。`)
    problems.push('用户根下有可疑的链接副本')
  } else {
    lines.push(`- \`${report.legacy.path}\` 存在但**不是本包装的** → 已保留未动。`)
  }
  lines.push('')
  lines.push(`清理脚本（不加参数即执行，加 \`--check\` 只报告；两个模式的默认值都会清）：\`node "${report.cleanup}"\``)
  lines.push('')

  lines.push('## 结论', '')
  if (problems.length === 0) {
    if (report.live?.status === 'ok') {
      lines.push(Array.isArray(report.presets)
        ? (report.live.running?.status === 'ok'
          ? `一切正常。运行时两个模式都在 roster 里；本工具当前在 \`${report.live.running.presetId}\` 里，技能与四个 story_* 工具都挂在各自那一层里。`
          : '一切正常。运行时两个模式都在 roster 里，技能与四个 story_* 工具都挂在各自那一层里；但没能判定本工具当前所在模式，见第一节的活体读数。')
        : '一切正常。运行时能看到这个模式，两份技能与四个工具都挂在本模式那一层里。')
    } else {
      lines.push('静态检查全部通过。运行时检查未取到（不在会话里时属正常）——在写作模式里调用一次本工具可拿到活体结果。')
    }
    return lines.join('\n')
  }
  lines.push(`有 ${problems.length} 处需要处理：`, '')
  for (const problem of problems) lines.push(`- ${problem}`)
  lines.push('')
  lines.push('清理（幂等，可反复执行；不动不是本包放的东西）：', '', '```sh')
  lines.push(`node "${report.cleanup}"`)
  lines.push('```', '', '只检查不改动：', '', '```sh')
  lines.push(`node "${report.cleanup}" --check`)
  lines.push('```')
  return lines.join('\n')
}

/**
 * 旧形状的第一节：报告对象只有一个 `patch` 字段、一份读数。
 *
 * 这段逐字保留原来的行与文案（包括活体那几行）：`renderDoctor` 是导出的 API，
 * 手工构造的报告和守着这些行的契约测试仍然用这个形状。新形状（两个模式各一份
 * 静态分析）走下面的 renderPresetSection。
 */
function renderSinglePresetSection(report, lines, problems) {
  const patch = report.patch
  lines.push('## 一、模式（自动：cordis.patch.yml 插入一行 preset 声明）', '')
  if (!report.viaProfile) {
    lines.push('**本包不在任何 profile 的 `node_modules` 下。** patch 只在 profile 合成配置时被读到，')
    lines.push('所以现在不会有 preset 声明被插入——模式不会出现。')
    lines.push('')
    lines.push('改用官方安装方式（一条命令，之后什么都不用跑）：')
    lines.push('')
    lines.push('```sh')
    lines.push('dsh plugin --profile <name> add github:<作者>/dsh-story-mode')
    lines.push('```')
    problems.push('包未装入 profile，patch 不生效')
  } else {
    const state = report.profileState
    lines.push(`安装点：\`${state.installedAt}\`（profile \`${state.profile}\`）`)
    lines.push('')
    lines.push('| 检查项 | 结果 |')
    lines.push('|---|---|')
    lines.push(`| 包已加入 profile 的 bundles | ${state.bundled ? '是' : '**否 —— patch 不会被加载**'} |`)
    lines.push(`| 子插件行能按裸包名解析到本包 | ${state.resolvable ? '是' : '**否 —— story-tools 那一行会 import 失败**'} |`)
    lines.push(`| package.json 能解析 | ${report.manifest.parses ? '是' : '**否**'} |`)
    lines.push(`| package.json 无 BOM | ${report.manifest.hasBom ? '**有 BOM —— DSH 读不出 dsh.bundle**' : '是'} |`)
    lines.push(`| 声明了 dsh.bundle.patch | ${report.manifest.declaresBundle ? '是' : '**否**'} |`)
    lines.push(`| files 字段包含 skills | ${report.manifest.filesIncludeSkills ? '是' : '**否 —— 发出去的包会缺技能**'} |`)
    lines.push(`| cordis.patch.yml 存在 | ${patch.present ? '是' : '**否**'} |`)
    lines.push(`| 是 \`insert\` 层（不是改别人的行） | ${patch.hasInsert ? '是' : '**否**'} |`)
    lines.push(`| 插入了 \`${PRESET_ROW_ID}\` 行 | ${patch.presetRow ? '是' : '**否**'} |`)
    lines.push(`| 用的是 \`${PRESET_PLUGIN}\` | ${patch.presetPlugin ? '是' : '**否**'} |`)
    lines.push(`| 声明的 preset id 是 ${PRESET_ID} | ${patch.presetId ? '是' : '**否**'} |`)
    lines.push(`| \`${STORY_TOOLS_ROW_ID}\` 行用裸包名 | ${patch.bareToolsRow ? '是' : '**否 —— 相对路径会按 profile 目录解析，import 失败**'} |`)
    lines.push(`| 没有 \`name: !!js\`（名字不会被插值） | ${patch.jsRowNames.length === 0 ? '是' : `**否 —— ${patch.jsRowNames.length} 处**`} |`)
    lines.push(`| 没有相对路径行名（子行不享受路径改写） | ${patch.relativeRowNames.length === 0 ? '是' : `**否 —— ${patch.relativeRowNames.join('、')}**`} |`)
    lines.push(`| 包内路径用 createRequire(baseUrl) 算 | ${patch.resolvesPackage && patch.unanchoredPathReads.length === 0 ? '是' : '**否 —— preset 树的 baseUrl 是 profile 目录**'} |`)
    lines.push(`| 双引号 \`!!js\` 里没有反斜杠转义 | ${patch.riskyScalars.length === 0 ? '是' : '**否 —— YAML 会先吃掉转义，v1.1.3 就栽在这里**'} |`)
    lines.push(`| 折叠 \`!!js\` 段里没有行注释 | ${patch.hasLineComment ? '**有，必须删掉**' : '是'} |`)
    lines.push(`| 声明了 \`customSkillDirs\` | ${patch.customSkillDirs ? '是' : '**否 —— 模式内加载不了技能**'} |`)
    lines.push(`| 包内 lib/index.js | ${report.packageFiles.libEntry ? '是' : '**否 —— story-tools 那一行会失败**'} |`)
    lines.push(`| 包内 skills/short-story/ | ${report.packageFiles.flowSkill ? '是' : '**否**'} |`)
    lines.push(`| 共用写作流程（references/） | ${report.packageFiles.workflow ? '是' : '**否 —— 写作流程无法加载**'} |`)
    lines.push(`| 审读面板（references/） | ${report.packageFiles.panel ? '是' : '**否 —— 派审读员那一步会悬空**'} |`)
    lines.push(`| 包内 skills/writing-style-contract/ | ${report.packageFiles.contract ? '是' : '**否 —— 动笔前加载它会报 unknown skill**'} |`)
    lines.push(`| 五个审读角色各自成行（persona + 只读 toolFilter） | ${report.reviewersRoleBased ? '是' : '**否 —— 角色人设或只读限制没进组合，退回成每次派发口头复述**'} |`)
    lines.push(`| 角色人设文件（references/reviewers/） | ${report.reviewersComplete ? '是' : '**否 —— 组合里的 !!js 会读不到文件，整个 preset 挂不上**'} |`)
    lines.push(`| 审读员可复用（continuable + send_message） | ${patch.reusable ? '是' : '**否 —— 每位审读员都会退化成一次性会话，改一轮就要重读全文**'} |`)
    const live = report.live ?? { status: 'unavailable' }
    if (live.status === 'ok') {
      lines.push(`| （活体）roster 里有 ${PRESET_ID} | ${liveCell(live.roster)}${live.roster?.status === 'missing' ? ` —— 现有：${(live.roster.ids ?? []).join(', ')}` : ''} |`)
      lines.push(`| （活体）本模式没有被判 broken | ${live.composition?.status === 'ok' ? (live.composition.broken === null ? '是' : '**否**') : liveCell(live.composition)} |`)
      lines.push(`| （活体）组合行数 / 已激活 | ${live.composition?.status === 'ok' ? `${live.composition.rows} / ${live.composition.active}` : liveCell(live.composition)} |`)
      lines.push(`| （活体）本作用域的技能 = 两份 | ${liveCell(live.skills)}${live.skills?.status === 'ok' ? ` —— ${live.skills.names.join('、')}` : ''} |`)
      lines.push(`| （活体）本作用域有四个 story_* 工具 | ${liveCell(live.tools)}${live.tools?.status === 'ok' ? ` —— ${live.tools.names.join('、') || '无'}` : ''} |`)
      lines.push(`| （活体）当前默认模式就是本模式 | ${live.roster?.status === 'ok' ? (live.roster.isDefault ? '是' : '否') : liveCell(live.roster)} |`)
    } else {
      lines.push(`| （活体）运行时检查 | 未取到${live.reason === undefined ? '' : `（${live.reason}）`} |`)
    }
    lines.push('')

    if (!state.bundled) problems.push('包没被加进 profile 的 bundles，patch 不会生效')
    if (!state.resolvable) problems.push('profile 的 node_modules 里找不到本包，story-tools 那一行会 import 失败')
    if (!report.manifest.parses) problems.push('package.json 解析失败（很可能是 BOM）')
    if (report.manifest.hasBom) problems.push('package.json 带 BOM，DSH 读不出 dsh.bundle 声明')
    if (!report.manifest.declaresBundle) problems.push('package.json 缺少 dsh.bundle 声明')
    if (!report.manifest.filesIncludeSkills) problems.push('files 字段不含 skills，发布出去会缺技能')
    if (!patch.present) problems.push('缺少 cordis.patch.yml，模式无人声明')
    if (!patch.hasInsert) problems.push('cordis.patch.yml 不是 insert 层（0.1.7 起 preset 只能靠插入自己的声明行）')
    if (!patch.presetRow) problems.push(`patch 没有插入 ${PRESET_ROW_ID} 行`)
    if (!patch.presetPlugin) problems.push(`patch 没有用 ${PRESET_PLUGIN} 声明 preset`)
    if (!patch.presetId) problems.push(`patch 没有声明 preset id ${PRESET_ID}`)
    if (!patch.bareToolsRow) problems.push(`${STORY_TOOLS_ROW_ID} 行没有用裸包名 ${PACKAGE_NAME}`)
    if (patch.jsRowNames.length > 0) problems.push('有行的 name 写成 !!js：loader 不会插值 name，整行会失败')
    if (patch.relativeRowNames.length > 0) problems.push('有行的 name 写成相对路径：config.plugins 里的名字按 profile 目录解析')
    if (!patch.resolvesPackage || patch.unanchoredPathReads.length > 0) problems.push('patch 里读包内文件没有走 createRequire(baseUrl)（baseUrl 是 profile 目录）')
    if (patch.riskyScalars.length > 0) problems.push('双引号 !!js 标量里有反斜杠转义：YAML 会先把它变成真字符')
    if (patch.hasLineComment) problems.push('折叠 !!js 段里有行注释，压成一行后会吃掉后面的代码')
    if (!patch.customSkillDirs) problems.push('patch 没有声明 customSkillDirs，模式内加载不了技能')
    if (!report.packageFiles.libEntry) problems.push('包内缺少 lib/index.js')
    if (!report.packageFiles.flowSkill) problems.push('包内缺少 skills/short-story/SKILL.md')
    if (!report.packageFiles.workflow) problems.push('包内缺少写作技能的 references/writing-workflow.md（共用写作流程）')
    if (!report.packageFiles.panel) problems.push('包内缺少写作技能的 references/review-panel.md（审读面板派发说明书）')
    if (!report.packageFiles.contract) problems.push('包内缺少 skills/writing-style-contract/SKILL.md')
    if (!report.reviewersComplete) problems.push('包内缺少审读角色人设文件（references/reviewers/*.md）')
    if (!report.reviewersRoleBased) problems.push('审读角色没有各自成行（缺 persona 或只读 toolFilter），派发边界会退回口头复述')
    if (!patch.reusable) problems.push('preset 里的审读员不是可复用子代理（缺 backgroundMode: continuable 或 send_message 工具行）')
    if (live.status === 'ok') {
      if (live.roster?.status === 'missing') problems.push(`运行时 roster 里没有 ${PRESET_ID}：重启一次 profile 让 patch 生效`)
      if (live.roster?.status === 'error' || live.composition?.status === 'error') {
        problems.push('运行时 roster 读取报错，见上表')
      }
      if (live.composition?.status === 'ok' && live.composition.broken !== null) {
        problems.push(`运行时报告本模式 broken：${live.composition.broken}`)
      }
      if (live.skills?.status === 'ok' && !SKILL_NAMES.every((name) => live.skills.names.includes(name))) {
        problems.push('本作用域里技能不齐：模式内加载技能会失败')
      }
      if (live.tools?.status === 'ok' && live.tools.names.length !== STORY_TOOLS.length) {
        problems.push(`本作用域里 story_* 工具只有 ${live.tools.names.length} 个（应为 ${STORY_TOOLS.length} 个）`)
      }
    }
    if (state.override !== undefined && state.override !== null) {
      lines.push(`**提醒：\`${state.override}\` 里有一段按 id \`${PRESET_ROW_ID}\` 的 patch。**`)
      lines.push('patch 按 id 整体替换 `config`（不是深合并），所以本模式跑的是你那一份，升级包不会覆盖它。')
      lines.push('想拿回包里的版本，删掉那一段再重启。')
      lines.push('')
    }
  }
}

/**
 * 新形状的第一节：两个模式各查一遍、各列一张表。
 *
 * 三段分开写（包与安装 / 完整版 / 精简版）是为了让"哪一层出问题"一眼可见：
 * 两层 patch 互不依赖，一层挂不上时另一层照样能用——而报告必须说清是哪一层，
 * 否则用户会以为"模式没出现"是整包没装好。
 */
function renderPresetSection(report, lines, problems) {
  const manifest = report.manifest
  lines.push('## 一、模式（自动：两层 bundle patch 各插入一行 preset 声明）', '')
  if (!report.viaProfile) {
    lines.push('**本包不在任何 profile 的 `node_modules` 下。** patch 只在 profile 合成配置时被读到，')
    lines.push('所以现在不会有 preset 声明被插入——两个模式都不会出现。')
    lines.push('')
    lines.push('改用官方安装方式（一条命令，之后什么都不用跑）：')
    lines.push('')
    lines.push('```sh')
    lines.push('dsh plugin --profile <name> add github:<作者>/dsh-story-mode')
    lines.push('```')
    lines.push('')
    problems.push('包未装入 profile，patch 不生效')
    renderLiveSection(report, lines)
    return
  }

  const state = report.profileState
  lines.push(`安装点：\`${state.installedAt}\`（profile \`${state.profile}\`）`)
  lines.push('')
  lines.push('### 包与安装（两个模式共用）', '')
  lines.push('| 检查项 | 结果 |')
  lines.push('|---|---|')
  lines.push(`| 包已加入 profile 的 bundles | ${state.bundled ? '是' : '**否 —— patch 不会被加载**'} |`)
  lines.push(`| 子插件行能按裸包名解析到本包 | ${state.resolvable ? '是' : '**否 —— story-tools 那一行会 import 失败**'} |`)
  lines.push(`| package.json 能解析 | ${manifest.parses ? '是' : '**否**'} |`)
  lines.push(`| package.json 无 BOM | ${manifest.hasBom ? '**有 BOM —— DSH 读不出 dsh.bundle**' : '是'} |`)
  lines.push(`| 声明了 dsh.bundle.patch | ${manifest.declaresBundle ? '是' : '**否**'} |`)
  if (Array.isArray(manifest.patchFiles)) {
    lines.push(`| bundle patch 文件（${manifest.patchFiles.length} 个） | ${manifest.patchFiles.join('、')} |`)
  }
  lines.push(`| files 字段包含 skills | ${manifest.filesIncludeSkills ? '是' : '**否 —— 发出去的包会缺技能**'} |`)
  lines.push(`| files 字段包含 skills-lite | ${manifest.filesIncludeSkillsLite ? '是' : '**否 —— 精简版会缺技能**'} |`)
  lines.push(`| 包内 lib/index.js | ${report.packageFiles.libEntry ? '是' : '**否 —— story-tools 那一行会失败**'} |`)
  lines.push('')

  for (const preset of report.presets) {
    const patch = preset.patch
    const badFiles = new Set(badFilePaths(preset.fileChecks))
    const orderOk = patch.orderValue === String(preset.expectedOrder)
    lines.push(`### ${preset.label}：\`${preset.patchFile}\` → \`${preset.rowId}\``)
    lines.push('')
    lines.push('| 检查项 | 结果 |')
    lines.push('|---|---|')
    lines.push(`| \`${preset.patchFile}\` 存在 | ${patch.present ? '是' : '**否**'} |`)
    lines.push(`| 是 \`insert\` 层（不是改别人的行） | ${patch.hasInsert ? '是' : '**否**'} |`)
    lines.push(`| 插入了 \`${preset.rowId}\` 行 | ${patch.presetRow ? '是' : '**否**'} |`)
    lines.push(`| 用的是 \`${PRESET_PLUGIN}\` | ${patch.presetPlugin ? '是' : '**否**'} |`)
    lines.push(`| 声明的 preset id 是 ${preset.presetId} | ${patch.presetId ? '是' : '**否**'} |`)
    lines.push(`| 声明了 order（本层应为 ${preset.expectedOrder}） | ${orderOk ? '是' : `**否 —— 实际 ${patch.orderValue === null ? '没写' : `\`${patch.orderValue}\``}**`} |`)
    lines.push(`| 声明了 name | ${patch.configName === null ? '**否**' : `是（${patch.configName}）`} |`)
    lines.push(`| \`${STORY_TOOLS_ROW_ID}\` 行用裸包名 | ${patch.bareToolsRow ? '是' : '**否 —— 相对路径会按 profile 目录解析，import 失败**'} |`)
    lines.push(`| 没有 \`name: !!js\`（名字不会被插值） | ${patch.jsRowNames.length === 0 ? '是' : `**否 —— ${patch.jsRowNames.length} 处**`} |`)
    lines.push(`| 没有相对路径行名（子行不享受路径改写） | ${patch.relativeRowNames.length === 0 ? '是' : `**否 —— ${patch.relativeRowNames.join('、')}**`} |`)
    lines.push(`| 包内路径用 createRequire(baseUrl) 算 | ${patch.resolvesPackage && patch.unanchoredPathReads.length === 0 ? '是' : '**否 —— preset 树的 baseUrl 是 profile 目录**'} |`)
    lines.push(`| 双引号 \`!!js\` 里没有反斜杠转义 | ${patch.riskyScalars.length === 0 ? '是' : '**否 —— YAML 会先吃掉转义，v1.1.3 就栽在这里**'} |`)
    lines.push(`| 折叠 \`!!js\` 段里没有行注释 | ${patch.hasLineComment ? '**有，必须删掉**' : '是'} |`)
    lines.push(`| 声明了 \`customSkillDirs\` | ${patch.customSkillDirs ? '是' : '**否 —— 模式内加载不了技能**'} |`)
    lines.push(`| 技能根指向包内 | ${sameList(patch.declaredSkillRoots, preset.skillRoots) ? `是（${preset.skillRoots.join('、')}）` : `**否 —— 实际 ${patch.declaredSkillRoots.length === 0 ? '没读到' : `\`${patch.declaredSkillRoots.join('`、`')}\``}**`} |`)
    for (const check of preset.fileChecks) {
      const missing = check.paths.filter((path) => badFiles.has(path))
      lines.push(`| ${check.label} | ${missing.length === 0 ? '是' : `**否 —— ${missing.length > 1 ? `${missing.length} 份缺失或为空` : `\`${missing[0]}\` 缺失或为空`}**`} |`)
    }
    lines.push(`| ${preset.reviewerCount === 1 ? '一位审读员各自成行（persona + 只读 toolFilter）' : `${preset.reviewerCount} 位审读员各自成行（persona + 只读 toolFilter）`} | ${preset.reviewersOk ? '是' : '**否 —— 角色人设或只读限制没进组合，派发边界退回口头复述**'} |`)
    lines.push(`| 审读员可复用（continuable + send_message） | ${patch.reusable ? '是' : '**否 —— 每位审读员都会退化成一次性会话，改一轮就要重读全文**'} |`)
    lines.push(`| 组合必需行（${preset.expectedRows} 行） | ${patch.missingRows.length === 0 ? '是' : `**否 —— 缺：${patch.missingRows.map((row) => `\`${row}\``).join('、')}**`} |`)
    if (preset.absentRows.length > 0) {
      lines.push(`| 有意不装的行（${preset.absentRows.join('、')}） | ${patch.unexpectedRows.length === 0 ? '是（未出现）' : `**否 —— 出现了 ${patch.unexpectedRows.join('、')}：每轮工具面会变宽**`} |`)
    }
    lines.push('')
  }

  renderLiveSection(report, lines)

  if (!state.bundled) problems.push('包没被加进 profile 的 bundles，patch 不会生效')
  if (!state.resolvable) problems.push('profile 的 node_modules 里找不到本包，story-tools 那一行会 import 失败')
  if (!manifest.parses) problems.push('package.json 解析失败（很可能是 BOM）')
  if (manifest.hasBom) problems.push('package.json 带 BOM，DSH 读不出 dsh.bundle 声明')
  if (!manifest.declaresBundle) problems.push('package.json 缺少 dsh.bundle 声明')
  if (manifest.filesIncludeSkillsLite === false) problems.push('files 字段不含 skills-lite，发布出去精简版会缺技能')
  if (!report.packageFiles.libEntry) problems.push('包内缺少 lib/index.js')
  for (const preset of report.presets) {
    const patch = preset.patch
    const where = `\`${preset.patchFile}\``
    // 声明了 patch 数组却没写这一层：DSH 读不到这个文件，模式静默少一个。
    if (Array.isArray(manifest.patchFiles)
      && !manifest.patchFiles.includes(preset.patchFile)
      && !manifest.patchFiles.includes(`./${preset.patchFile}`)) {
      problems.push(`package.json 的 dsh.bundle.patch 没有声明 ${preset.patchFile}：这一层 patch 不会被读到`)
    }
    if (!patch.present) {
      // 一层 patch 不在：只报这一条。下面每一条都是"文件不在了"的下游现象（不是 insert 层、
      // 没有声明 id、order 读不到、组合缺二十来行……），一次故障刷成一屏会把根因埋掉；
      // 而且表格里那一层每一项已经显示"否"，细节并没有丢。
      problems.push(`缺少 ${preset.patchFile}：${preset.label}无人声明`)
    } else {
      if (!patch.hasInsert) problems.push(`${where} 不是 insert 层（0.1.7 起 preset 只能靠插入自己的声明行）`)
      if (!patch.presetRow) problems.push(`${where} 没有插入 ${preset.rowId} 行`)
      if (!patch.presetPlugin) problems.push(`${where} 没有用 ${PRESET_PLUGIN} 声明 preset`)
      if (!patch.presetId) problems.push(`${where} 没有声明 preset id ${preset.presetId}`)
      if (patch.orderValue !== String(preset.expectedOrder)) problems.push(`${where} 的 order 不是 ${preset.expectedOrder}（实际 ${patch.orderValue ?? '没写'}）：模式在列表里的位置会变`)
      if (patch.configName === null) problems.push(`${where} 没有声明 config.name：模式在列表里没有名字`)
      if (!patch.bareToolsRow) problems.push(`${where} 的 ${STORY_TOOLS_ROW_ID} 行没有用裸包名 ${PACKAGE_NAME}`)
      if (patch.jsRowNames.length > 0) problems.push(`${where}：有行的 name 写成 !!js（loader 不会插值 name，整行会失败）`)
      if (patch.relativeRowNames.length > 0) problems.push(`${where}：有行的 name 写成相对路径（config.plugins 里的名字按 profile 目录解析）`)
      if (!patch.resolvesPackage || patch.unanchoredPathReads.length > 0) problems.push(`${where}：读包内文件没有走 createRequire(baseUrl)（baseUrl 是 profile 目录）`)
      if (patch.riskyScalars.length > 0) problems.push(`${where}：双引号 !!js 标量里有反斜杠转义（YAML 会先把它变成真字符）`)
      if (patch.hasLineComment) problems.push(`${where}：折叠 !!js 段里有行注释，压成一行后会吃掉后面的代码`)
      if (!patch.customSkillDirs) problems.push(`${where} 没有声明 customSkillDirs，${preset.label}加载不了技能`)
      if (!sameList(patch.declaredSkillRoots, preset.skillRoots)) {
        problems.push(`${where} 的技能根不是 ${preset.skillRoots.join('、')}（实际：${patch.declaredSkillRoots.join('、') || '没读到'}）`)
      }
      if (!preset.reviewersOk) problems.push(`${preset.label}：审读员的人设或只读 toolFilter 没进组合，派发边界会退回口头复述`)
      if (!patch.reusable) problems.push(`${preset.label}：审读员不是可复用子代理（缺 backgroundMode: continuable 或 send_message 工具行）`)
      if (patch.missingRows.length > 0) problems.push(`${preset.label}的组合缺行：${patch.missingRows.join('、')}`)
      if (patch.unexpectedRows.length > 0) problems.push(`${preset.label}里出现了有意不装的行：${patch.unexpectedRows.join('、')}（每轮工具面会变宽）`)
    }
    // 包内文件检查与 patch 在不在是两件事：技能文件缺失要独立报出来。
    for (const check of preset.fileChecks) {
      if (badFilePaths([check]).length > 0) problems.push(check.missing)
    }
  }
  const live = report.live ?? { status: 'unavailable' }
  if (live.status === 'ok') {
    for (const preset of report.presets) {
      const reading = live.presets?.[preset.presetId] ?? {}
      if (reading.roster?.status === 'missing') problems.push(`运行时 roster 里没有 ${preset.presetId}：重启一次 profile 让 patch 生效`)
      if (reading.roster?.status === 'error' || reading.composition?.status === 'error') {
        problems.push(`运行时读 ${preset.presetId} 的状态报错，见上表`)
      }
      if (reading.composition?.status === 'ok' && reading.composition.broken !== null) {
        problems.push(`运行时报告 ${preset.presetId} broken：${reading.composition.broken}`)
      }
      if (reading.scope?.skills?.status === 'ok' && !preset.liveSkills.every((name) => reading.scope.skills.names.includes(name))) {
        problems.push(`运行时 ${preset.presetId} 作用域里技能不齐：模式内加载技能会失败`)
      }
      if (reading.scope?.tools?.status === 'ok' && reading.scope.tools.names.length !== STORY_TOOLS.length) {
        problems.push(`运行时 ${preset.presetId} 作用域里 story_* 工具只有 ${reading.scope.tools.names.length} 个（应为 ${STORY_TOOLS.length} 个）`)
      }
    }
  }
  if (state.overrides !== null && state.overrides !== undefined) {
    for (const rowId of state.overrides.rowIds) {
      lines.push(`**提醒：\`${state.overrides.file}\` 里有一段按 id \`${rowId}\` 的 patch。**`)
    }
    lines.push('patch 按 id 整体替换 `config`（不是深合并），所以那一段跑的是你那一份，升级包不会覆盖它。')
    lines.push('想拿回包里的版本，删掉那一段再重启。')
    lines.push('')
  }
}

/**
 * 活体一节：按 id 逐项列，两个模式各一份；"本工具当前所在"单独一行。
 *
 * 为什么不合成一行：两个模式是 roster 里两条独立声明，一条挂不上不影响另一条。
 * 旧版把 `short-story` 的读数当成"本模式"的健康状况，在精简版会话里报的是另一层
 * ——两边都看不出错。现在判不出当前所在时也照实写"未能判定"，绝不拿一个顶另一个。
 */
function renderLiveSection(report, lines) {
  const live = report.live ?? { status: 'unavailable' }
  lines.push('### 活体（运行时读数，两个模式各一份）', '')
  if (live.status !== 'ok') {
    lines.push(`- 未取到${live.reason === undefined ? '' : `（${live.reason}）`}。不在会话里调用时属正常。`)
    lines.push('')
    return
  }
  lines.push('| 检查项 | 结果 |')
  lines.push('|---|---|')
  for (const preset of report.presets) {
    const reading = live.presets?.[preset.presetId] ?? {}
    const roster = reading.roster
    const isDefault = roster?.status === 'ok' && roster.isDefault ? ' —— **默认**' : ''
    const existing = roster?.status === 'missing' ? ` —— 现有：${(live.rosterIds ?? []).join('、') || '空'}` : ''
    const skills = reading.scope?.status === 'ok'
      ? `${liveCell(reading.scope.skills)}${reading.scope.skills?.status === 'ok' ? ` —— ${reading.scope.skills.names.join('、') || '无'}` : ''}`
      : liveCell(reading.scope)
    const tools = reading.scope?.status === 'ok'
      ? `${liveCell(reading.scope.tools)}${reading.scope.tools?.status === 'ok' ? ` —— ${reading.scope.tools.names.join('、') || '无'}` : ''}`
      : liveCell(reading.scope)
    lines.push(`| （活体）roster 里有 ${preset.presetId} | ${liveCell(roster)}${existing}${isDefault} |`)
    lines.push(`| （活体）${preset.presetId} 没有被判 broken | ${reading.composition?.status === 'ok' ? (reading.composition.broken === null ? '是' : '**否**') : liveCell(reading.composition)} |`)
    lines.push(`| （活体）${preset.presetId} 组合行数 / 已激活 | ${reading.composition?.status === 'ok' ? `${reading.composition.rows} / ${reading.composition.active}` : liveCell(reading.composition)} |`)
    lines.push(`| （活体）${preset.presetId} 作用域里的技能 | ${skills} |`)
    lines.push(`| （活体）${preset.presetId} 作用域里的 story_* 工具 | ${tools} |`)
  }
  const running = live.running
  lines.push(running?.status === 'ok'
    ? `| （活体）本工具当前所在模式 | \`${running.presetId}\`（由 agentPresets.composedPreset(agent.ctx) 判定） |`
    : `| （活体）本工具当前所在模式 | **未能判定** —— ${running?.reason ?? '原因未知'}；上面按 id 分别列出两个模式，不拿一个顶另一个 |`)
  const liveDefaults = PRESET_IDS.filter((id) => live.presets?.[id]?.roster?.status === 'ok' && live.presets[id].roster.isDefault === true)
  lines.push(`| （活体）当前默认模式 | ${liveDefaults.length === 0 ? '不是本包这两个模式' : liveDefaults.map((id) => `\`${id}\``).join('、')} |`)
  lines.push('')
}

/** 文件检查里"缺失或为空"的路径（报告要写清是哪一个）。 */
function badFilePaths(fileChecks) {
  const bad = []
  for (const check of fileChecks) {
    for (const [path, state] of Object.entries(check.states)) {
      if (!state.present || state.empty) bad.push(path)
    }
  }
  return bad
}

/** 两个字符串列表是不是同一组（顺序也算：技能根的先后决定技能出现顺序）。 */
function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 活体读数里"哪个 preset 是默认"的那张表。
 *
 * 新形状是 `live.presets[id].roster`；旧形状只有一个扁平的 `live.roster`
 * （单 preset 的报告），按完整版 id 记——旧形状里没有第二个模式可言。
 */
function liveDefaultRows(live) {
  if (live?.status !== 'ok') return {}
  if (live.presets !== undefined) {
    return Object.fromEntries(Object.entries(live.presets).map(([id, state]) => [id, state.roster]))
  }
  return live.roster === undefined ? {} : { [PRESET_ID]: live.roster }
}

/**
 * 构造自检工具定义。
 *
 * 用 `tool-kit` 的工厂，所以这个入口不依赖主入口——`dsh-story-mode/doctor`
 * 可以单独挂到任何模式里，不需要连带加载写作工具。传了 `ctx` 时会在报告里
 * 附上活体检查（两个模式的 roster / 技能 / 工具）。
 */
export function doctorTool(ctx) {
  return makeTool({
    name: 'story_doctor',
    description: [
      'Verify how this package is installed and whether DSH can actually run its modes.',
      'Since DSH 0.1.7 a mode is a preset declaration row INSERTED by a bundle patch',
      '(@deepseek-ai/dsh-agent-preset with an inline plugins list) — the preset registry scans no directories,',
      'so the package must sit under a profile\'s node_modules for those patches to be read at all, and the child row',
      'resolves this package by its bare name from the profile directory.',
      'The package ships TWO independent layers and this report checks each one on its own: cordis.patch.yml declares',
      'preset short-story (five role-based read-only reviewers) and cordis.lite.patch.yml declares short-story-lite',
      '(one merged reviewer, two skill roots, deliberately no tool-web/tool-goal). A check that passes for one layer',
      'therefore never stands in for the other.',
      'The skills travel inside the package: each preset mounts its own roots via customSkillDirs, so they exist ONLY',
      'inside that mode and nothing is installed into the user\'s home.',
      'Reports per check, per layer: patch shape (insert layer, row name is a bare package name and never a !!js',
      'expression, package-internal paths computed with createRequire(baseUrl)), the declared preset id/order/name,',
      'the skill roots and that every skill and reviewer persona file ships non-empty, the required plugin rows,',
      'and that reviewers are reusable (continuable) read-only subagents.',
      'With a runtime context it adds the LIVE roster/composition state plus the skills and story_* tools registered',
      'inside EACH preset scope, and names the preset this call actually runs in — read through the registry\'s own',
      'composedPreset(agent.ctx) — instead of assuming one of them.',
      'It also reports two leftovers worth knowing about: a user-root skill copy from v1.0.1/v1.0.2, and an earlier',
      'preset copy that would collide on the preset id. Learn any profile patch that overrides either preset row.',
      'Before uninstall it warns when EITHER preset id is the selected default, naming the actual id, because the',
      'registry does not fall back and new sessions would then fail with agent-preset/not-found.',
      'Takes no arguments and changes nothing; it prints the exact commands to repair what it finds.',
    ].join(' '),
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '短篇小说模式安装自检', kind: 'read', rawInput: 'doctor' }),
    // 注意：`makeTool` 收的是 `run`，不是注册表定义里的 `execute`——工厂自己包一层
    // execute 做参数校验与输出 schema，漏写 `run` 会在调用时报 "run is not a function"。
    async run(_args, exec) {
      // `exec.agent.ctx` 是注册表判定"这次调用跑在哪个 preset 里"的入口
      // （`composedPreset(agent.ctx)`）；拿不到就如实报"未能判定"，不猜。
      return renderDoctor(await runDoctor(ctx, exec?.agent?.ctx))
    },
  })
}

/** 独立挂载入口：只注册自检工具。 */
export function apply(ctx) {
  ctx.tools.register(doctorTool(ctx))
}
