/**
 * `dsh-story-mode/doctor` —— 安装自检（DSH 0.1.7-rc.1 及以后）。
 *
 * 这套能力的落地方式分两半，自检必须分开回答，因为失败模式完全不同：
 *
 * ── 一半是模式：**自动**，由包的 `cordis.patch.yml` 插入一行 preset 声明 ──────
 *
 * 0.1.7 起，preset 不再是"文件系统上的目录"，而是普通的 loader 行：
 * `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 就是子插件列表，注册表
 * （`ctx.agentPresets`）**不扫描目录，也不接受预设路径**。所以本包只做一件事：
 * 在 bundle patch 里 `insert` 一行 `preset-short-story`。装好包、重启一次 profile，
 * 模式就在列表里；卸载包，这一层 patch 消失，模式跟着消失。
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
 *   * roster 里有没有 `short-story`，`broken` 是不是空；
 *   * 本 preset 那一层里的技能是不是正好那两份（`ctx.skills.list({ scope })`）；
 *   * 本 preset 那一层里有没有四个 `story_*` 工具（`ctx.tools.schemas(scope)`）。
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
 * 静态分析 `cordis.patch.yml`。
 *
 * 判据只针对**形状**：插入了哪一行、子行的名字是哪种写法、包内路径怎么算出来的。
 * 每一条都对应一个真实踩过的失败模式（见文件头）。
 */
function analysePatch(raw) {
  if (raw === null) return { present: false }
  const hasInsert = /^-\s*insert:\s*$/m.test(raw)
  const presetRow = new RegExp(`^\\s*-\\s*id:\\s*${PRESET_ROW_ID}\\s*$`, 'm').test(raw)
  const presetPlugin = new RegExp(`^\\s*name:\\s*'?${PRESET_PLUGIN.replace(/[/@]/g, (c) => `\\${c}`)}'?\\s*$`, 'm').test(raw)
  const presetId = new RegExp(`^\\s*id:\\s*${PRESET_ID}\\s*$`, 'm').test(raw)
  // 子插件行的名字必须是裸包名：`insert` 之外的名字不会被启动器改写，相对路径会按
  // profile 目录解析；`!!js` 名字根本不会被插值。两种都能让整行 import 失败。
  const bareToolsRow = new RegExp(`-\\s*id:\\s*${STORY_TOOLS_ROW_ID}\\s*\\n\\s*name:\\s*${PACKAGE_NAME}\\s*$`, 'm').test(raw)
  const jsRowNames = [...raw.matchAll(/^[ \t]*name:\s*!!js/gm)].map((m) => m[0])
  const relativeRowNames = [...raw.matchAll(/^[ \t]*name:\s*(\.\.?\/[^\s]*)/gm)].map((m) => m[1])
  // 包内路径必须由 createRequire(baseUrl) 在运行时问出来：preset 树的 baseUrl 是
  // profile 目录，写死的相对路径会指向 profile，而不是包。
  const resolvesPackage = raw.includes(`createRequire(baseUrl).resolve('${PACKAGE_NAME}/package.json')`)
  const pathReadsFiles = [...raw.matchAll(/!!js\s+"([^"]*)"/g)]
    .map((m) => m[1])
    .filter((expr) => expr.includes('skills/'))
  const unanchoredPathReads = pathReadsFiles.filter((expr) => !expr.includes(`createRequire(baseUrl).resolve('${PACKAGE_NAME}/package.json')`))
  // 双引号标量里的反斜杠转义会被 YAML 先处理掉：`'\n'` 会变成真换行，JS 源码跨行。
  // v1.1.3 正是栽在这里，所以单列一项。
  const riskyScalars = [...raw.matchAll(/!!js[ \t]+"[^"\n]*\\[^"\n]*"/g)].map((m) => m[0].slice(0, 60))
  // 折叠标量（`!!js >-`）会被压成一行，一个 `//` 注释就能吃掉后面全部代码。
  const foldedAt = raw.indexOf('!!js >-')
  const hasLineComment = foldedAt >= 0
    && raw.slice(foldedAt + '!!js >-'.length).split(/\r?\n/).some((line) => /(^|\s)\/\//.test(line))
  const customSkillDirs = raw.includes('customSkillDirs:')
  return {
    present: true,
    hasInsert,
    presetRow,
    presetPlugin,
    presetId,
    bareToolsRow,
    jsRowNames,
    relativeRowNames,
    resolvesPackage,
    unanchoredPathReads,
    riskyScalars,
    hasLineComment,
    customSkillDirs,
    reviewerRows: Object.fromEntries(REVIEWER_IDS.map((role) => [role, {
      toolName: raw.includes(`toolName: subagent_review_${role}`),
      persona: raw.includes(`reviewers/${REVIEWER_FILE[role]}`),
      readOnly: raw.includes('allow: [read, read_image, str_replace_editor, glob, grep]'),
      deniesWrites: raw.includes('deny: [write, edit, present,'),
    }])),
    reusable: raw.includes('backgroundMode: continuable') && raw.includes("'@deepseek-ai/dsh-tool-subagent-control'"),
  }
}

/**
 * 用户选定的默认预设。
 *
 * 0.1.7 起默认值有两个来源：部署的 `agent-preset-registry` 行 `config.default`，
 * 以及**用户**选择覆盖的 volatile 字段 `config.selectedDefault`。用户那一份由
 * loader 写回它所在的那一层——profile 的 `cordis.patch.yml`（Web 配置编辑器也
 * 写在这里），有时还会出现在 profile 根配置的转储里。所以静态检查要扫这三个
 * 位置；活体检查（`ctx.agentPresets.remoteExportList()` 的 `isDefault`）更准，
 * 能拿到就以它为准。
 *
 * 为什么单列一项：本模式被设成默认之后再卸载包，新建会话会直接以
 * `agent-preset/not-found` 失败——注册表的 `resolve()`／`retain()` 找不到默认 id
 * 时**不回退**到 `standard`，而会顺手清掉这个默认值的那条路径被
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
      // 只看 selectedDefault / default 这两个字段上的取值，别把描述文本里的
      // "short-story" 当成默认值。
      const match = source.raw.match(/^\s*(?:selectedDefault|default):\s*['"]?([\w-]+)['"]?\s*$/m)
      if (match !== null) return { id: match[1], source: source.label }
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

/** profile 的 patch 层有没有覆盖本包那一行（用户改过组合）。 */
async function readOverride(home, install) {
  if (install === null) return null
  const raw = await readIfPresent(join(home, 'profiles', install.profile, 'cordis.patch.yml'))
  if (raw === null) return null
  const escaped = PRESET_ROW_ID.replace(/[-/]/g, (c) => `\\${c}`)
  return new RegExp(`^\\s*-\\s*id:\\s*${escaped}\\s*$`, 'm').test(raw) ? `${install.profile}/cordis.patch.yml` : null
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
 * 问运行时本身：模式真的装起来了吗？
 *
 * 全部尽力而为：服务不可见、调用抛错、超时，都只记状态，不算故障。
 */
async function probeLive(ctx) {
  if (ctx === undefined || typeof ctx.get !== 'function') return { status: 'unavailable', reason: '没有 ctx（独立调用）' }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return { status: 'unavailable', reason: 'agentPresets 服务不可见' }
  const result = { status: 'ok' }
  try {
    const roster = await withTimeout(presets.remoteExportList(), LIVE_TIMEOUT_MS)
    if (roster === TIMEOUT) result.roster = { status: 'timeout' }
    else {
      const row = roster.presets.find((preset) => preset.id === PRESET_ID)
      result.roster = row === undefined
        ? { status: 'missing', ids: roster.presets.map((preset) => preset.id) }
        : { status: 'ok', isDefault: row.isDefault === true, name: row.name ?? null, order: row.order ?? null }
    }
  } catch (error) {
    result.roster = { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    const inventory = await withTimeout(presets.compositionInventory(), LIVE_TIMEOUT_MS)
    if (inventory === TIMEOUT) result.composition = { status: 'timeout' }
    else {
      const mine = inventory.find((preset) => preset.id === PRESET_ID)
      result.composition = mine === undefined
        ? { status: 'missing' }
        : {
            status: 'ok',
            broken: mine.broken ?? null,
            rows: mine.rows.length,
            active: mine.rows.filter((row) => String(row.fiberState) === '2').length,
          }
    }
  } catch (error) {
    result.composition = { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
  if (result.roster?.status === 'ok' && result.composition?.status === 'ok' && result.composition.broken === null) {
    try {
      const lease = await withTimeout(presets.acquireScope(PRESET_ID), LIVE_TIMEOUT_MS)
      if (lease === TIMEOUT) result.scope = { status: 'timeout' }
      else {
        try {
          const skills = ctx.get('skills')
          const list = skills === undefined ? undefined : await withTimeout(skills.list({ scope: lease.key }), LIVE_TIMEOUT_MS)
          result.skills = list === undefined || list === TIMEOUT
            ? { status: list === TIMEOUT ? 'timeout' : 'unavailable' }
            : { status: 'ok', names: list.map((skill) => skill.name) }
          const tools = ctx.get('tools')
          if (tools === undefined) result.tools = { status: 'unavailable' }
          else {
            const schemas = tools.schemas(lease.key).map((tool) => tool.name)
            result.tools = { status: 'ok', names: schemas.filter((tool) => tool.startsWith('story_')) }
          }
        } finally {
          await lease[Symbol.asyncDispose]().catch(() => {})
        }
      }
    } catch (error) {
      result.scope = { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  return result
}

/** 跑完整套自检。`ctx` 可选：给了就顺带做活体检查。 */
export async function runDoctor(ctx) {
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
      manifest = {
        parses: true,
        hasBom: manifest.hasBom,
        declaresBundle: parsed.dsh?.bundle?.patch !== undefined,
        filesIncludeSkills: Array.isArray(parsed.files) && parsed.files.includes('skills'),
      }
    } catch {
      manifest.parses = false
    }
  }

  const patch = analysePatch(await readIfPresent(join(root, 'cordis.patch.yml')))

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
    profileState = {
      present: true,
      profile: install.profile,
      installedAt: install.installed,
      bundled: bundles.includes(PACKAGE_NAME),
      // 子行的裸包名要靠 profile 的 node_modules 解析：这正是 `story-tools` 那一行
      // 能加载的前提。
      resolvable: await exists(join(install.installed, 'package.json')),
      override: await readOverride(home, install),
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

  const live = await probeLive(ctx)
  const defaultPreset = await readDefaultPreset(home, install)

  return {
    root,
    home,
    version,
    patch,
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
}

function liveCell(section, render) {
  if (section === undefined) return '未取到'
  return LIVE_LABEL[section.status] ?? section.status
}

/** 渲染报告。只报事实与修法，不替用户下"应该没问题"的结论。 */
export function renderDoctor(report) {
  const problems = []
  const patch = report.patch
  const lines = [
    '# dsh-story-mode 安装自检',
    '',
    `- 包目录：\`${report.root}\``,
    `- 包版本：${report.version}`,
    `- harness 主目录：\`${report.home}\``,
    '',
    '## 一、模式（自动：cordis.patch.yml 插入一行 preset 声明）',
    '',
  ]

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
  const liveDefault = report.live?.roster?.status === 'ok' ? report.live.roster.isDefault : undefined
  const staticDefault = report.defaultPreset
  lines.push('## 三、卸载前要注意的', '')
  if (liveDefault === true || (liveDefault === undefined && staticDefault?.id === PRESET_ID)) {
    lines.push('**你的默认模式就是本模式。** 卸载包之前必须先清掉这个默认值——')
    lines.push('否则新建会话（不带显式 preset）会直接以 `agent-preset/not-found` 失败。')
    lines.push('注册表找不到默认 id 时不会回退，而卸载又绕过了会顺手清掉它的那条路径。')
    lines.push('所以这一步必须在 `dsh plugin remove` **之前**做：')
    lines.push('')
    lines.push('```sh')
    lines.push('dsh plugin --profile <name> exec dsh-story-mode cleanup')
    lines.push('```')
    problems.push('默认预设指向本模式，卸载前必须先清理')
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
  lines.push(`清理脚本（不加参数即执行，加 \`--check\` 只报告）：\`node "${report.cleanup}"\``)
  lines.push('')

  lines.push('## 结论', '')
  if (problems.length === 0) {
    if (report.live?.status === 'ok') {
      lines.push('一切正常。运行时能看到这个模式，两份技能与四个工具都挂在本模式那一层里。')
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
 * 构造自检工具定义。
 *
 * 用 `tool-kit` 的工厂，所以这个入口不依赖主入口——`dsh-story-mode/doctor`
 * 可以单独挂到任何模式里，不需要连带加载写作工具。传了 `ctx` 时会在报告里
 * 附上活体检查（roster / 技能 / 工具）。
 */
export function doctorTool(ctx) {
  return makeTool({
    name: 'story_doctor',
    description: [
      'Verify how this package is installed and whether DSH can actually run its mode.',
      'Since DSH 0.1.7 the mode is a preset declaration row INSERTED by the package\'s cordis.patch.yml',
      '(@deepseek-ai/dsh-agent-preset with an inline plugins list) — the preset registry scans no directories,',
      'so the package must sit under a profile\'s node_modules for that patch to be read at all, and the child row',
      'resolves this package by its bare name from the profile directory.',
      'The two skills travel inside the package: the preset mounts them via customSkillDirs, so they exist ONLY',
      'inside this mode and nothing is installed into the user\'s home.',
      'Reports per check: patch shape (insert layer, row name is a bare package name and never a !!js expression,',
      'package-internal paths computed with createRequire(baseUrl)), that the plugin entry, both skills and all five',
      'reviewer persona files ship with the package, that reviewers are reusable (continuable) read-only subagents,',
      'and — when a runtime context is available — the LIVE roster/composition state plus the skills and story_* tools',
      'registered inside this preset scope.',
      'It also reports two leftovers worth knowing about: a user-root skill copy from v1.0.1/v1.0.2, and an earlier',
      'preset copy that would collide on the preset id. Learn any profile patch that overrides this preset row.',
      'Takes no arguments and changes nothing; it prints the exact commands to repair what it finds.',
    ].join(' '),
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '短篇小说模式安装自检', kind: 'read', rawInput: 'doctor' }),
    // 注意：`makeTool` 收的是 `run`，不是注册表定义里的 `execute`——工厂自己包一层
    // execute 做参数校验与输出 schema，漏写 `run` 会在调用时报 "run is not a function"。
    async run() {
      return renderDoctor(await runDoctor(ctx))
    },
  })
}

/** 独立挂载入口：只注册自检工具。 */
export function apply(ctx) {
  ctx.tools.register(doctorTool(ctx))
}
