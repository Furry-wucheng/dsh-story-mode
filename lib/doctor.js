/**
 * `dsh-story-mode/doctor` —— 安装自检。
 *
 * 这套能力的落地方式分两半，自检必须分开回答，因为失败模式完全不同：
 *
 * ── 一半是模式：**自动**，由包的 `cordis.patch.yml` 接管 ────────────────────
 *
 * 装好包之后，profile 启动时 patch 会用 `createRequire(ctx.baseUrl)` 问出本包
 * 装在哪，把包内 `presets/` 声明为 roster 的一个根。所以模式不需要任何安装
 * 步骤，卸载包就自动消失。
 *
 * 但这条链上有几个**静默**的失败点，全都表现为"模式就是不出现"：
 *   1. 包没被装进 profile 的 node_modules（例如直接从 clone 的目录挂载），
 *      patch 根本没被读到；
 *   2. profile 里已经有官方的 roster 行，本包的行按设计**退让**——这不算错，
 *      但用户会以为自己装失败了；
 *   3. `presets/` 没进包的 `files` 字段，发出去的包里没有模式文件；
 *   4. patch 的 `!!js` 里混进了行注释——它会被折叠成一行，一个 `//` 吃掉后面
 *      全部代码。
 *
 * ── 另一半是全局技能：**手动**，必须复制到 `<DSH_HOME>/skills` ──────────────
 *
 * 技能只从固定的根发现，插件无法往里声明根，所以那一份是复制过去的，
 * 会过期，也需要显式清理。
 *
 * ── 一个反直觉但关键的事实 ─────────────────────────────────────────────────
 *
 * 模式侧真正的发现判定是 `dsh-agent-presets` 的
 * `readdir(root, { withFileTypes: true })` → `child.isDirectory()`，
 * **不跟随符号链接**。Windows 上 Node 把 junction 报成符号链接，于是链接形式的
 * 预设会被**静默跳过**，而 `stat()` 和读文件却完全正常。本包早期版本正是栽在
 * 这一点上，所以下面的检查复刻 roster 的判定，而不是用"文件读得到"这种会撒谎的
 * 宽松判据。
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
const SKILL_NAME = 'writing-style-contract'
const MARKER = '.dsh-story-mode.json'

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
    const installed = join(profilesRoot, entry.name, 'node_modules', 'dsh-story-mode')
    if (!(await exists(join(installed, 'package.json')))) continue
    // 只认真的导出 apply 的那一份；目录里躺着别的同名东西时不要误判。
    return { profile: entry.name, installed }
  }
  return null
}

/**
 * 复刻 roster 的判定：`readdir().isDirectory()` + 组成可读。
 *
 * 只看"文件能不能读"会给假绿——链接形态读得到、却被 roster 跳过。
 */
async function probePresetDir(root) {
  let entry
  try {
    const children = await readdir(root, { withFileTypes: true })
    entry = children.find((child) => child.name === PRESET_ID)
  } catch {
    return { status: 'no-root' }
  }
  if (entry === undefined) return { status: 'missing' }
  if (entry.isSymbolicLink()) return { status: 'is-link' }
  if (!entry.isDirectory()) return { status: 'not-a-directory' }

  const composition = join(root, PRESET_ID, 'agent.cordis.yml')
  const raw = await readIfPresent(composition)
  if (raw === null) return { status: 'incomplete' }

  // 组成里指向插件的行：相对引用，基准是组成文件所在目录。
  const match = raw.match(/^\s*-\s*id:\s*story-tools\s*\n\s*name:\s*['"]?([^'"\s]+)/m)
  if (match === null) return { status: 'ok', pluginRow: null }
  return {
    status: 'ok',
    pluginRow: match[1],
    pluginRowResolves: await exists(join(root, PRESET_ID, match[1])),
  }
}

/** 递归列出相对文件路径（排序）。 */
async function listFiles(dir, prefix = '') {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) found.push(rel)
  }
  return found.sort()
}

/** 已落地的技能是否与包内不一致。 */
async function skillDrift(source, dest) {
  const [src, dst] = await Promise.all([listFiles(source), listFiles(dest)])
  const left = src.filter((f) => f !== MARKER)
  const right = dst.filter((f) => f !== MARKER)
  if (left.length !== right.length) return true
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return true
  for (const rel of left) {
    const [a, b] = await Promise.all([
      readFile(join(source, rel)).catch(() => null),
      readFile(join(dest, rel)).catch(() => null),
    ])
    if (a === null || b === null || !a.equals(b)) return true
  }
  return false
}

/**
 * patch 的 `!!js` 代码段里有没有行注释。
 *
 * 折叠标量会把代码压成一行，一个 `//` 就把后面的全部吃掉——这是本包实际踩过的
 * 坑，所以单列一项检查。
 */
function patchJsHasLineComment(raw) {
  if (raw === null) return false
  const at = raw.indexOf('!!js >-')
  if (at < 0) return false
  const script = raw.slice(at + '!!js >-'.length)
  return script.split(/\r?\n/).some((line) => /(^|\s)\/\//.test(line))
}

/** 跑完整套自检。 */
export async function runDoctor() {
  const root = packageRoot()
  const home = dshHome()

  let version = 'unknown'
  try {
    version = JSON.parse((await readIfPresent(join(root, 'package.json'))) ?? '{}').version ?? 'unknown'
  } catch {
    // 版本只用于展示
  }

  const patchRaw = await readIfPresent(join(root, 'cordis.patch.yml'))
  const patch = {
    present: patchRaw !== null,
    // 本包接管官方的 `agent-presets` 行（补丁按 id 覆写它的 config）。
    targetsRosterRow: /^-\s*id:\s*agent-presets\s*$/m.test(patchRaw ?? ''),
    resolvesOwnPackage: patchRaw?.includes("resolve('dsh-story-mode/package.json')") ?? false,
    hasLineComment: patchJsHasLineComment(patchRaw),
    restatesShippedRoots: (patchRaw?.includes('includeShippedRoot') ?? false)
      && (patchRaw?.includes('includeUserRoot') ?? false),
  }

  const presetRootInPackage = join(root, 'presets')
  const presetInPackage = await probePresetDir(presetRootInPackage)
  const install = await findProfileInstall(home)
  const viaProfile = install !== null

  // profile 侧是否已有官方的 roster 行、本包是否已在 bundles 里
  let profileState = { present: false, bundled: false, officialRosterPresent: null }
  if (install !== null) {
    const profileDir = join(home, 'profiles', install.profile)
    const profilePatch = await readIfPresent(join(profileDir, 'cordis.patch.yml'))
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
      bundled: bundles.includes('dsh-story-mode'),
      officialRosterPresent: (profilePatch?.includes('agent-presets') ?? false)
        || bundles.includes('@deepseek-ai/dsh-web-app'),
    }
  }

  // 包自己的 package.json 必须是无 BOM 的合法 JSON——带 BOM 会让 DSH 读不出
  // `dsh.bundle` 声明，于是包不会被加进 profile 的 bundles，patch 永远不生效。
  const ownManifestRaw = await readIfPresent(join(root, 'package.json'))
  let manifest = { parses: false, declaresBundle: false, filesIncludesPresets: false, hasBom: false }
  if (ownManifestRaw !== null) {
    manifest.hasBom = ownManifestRaw.charCodeAt(0) === 0xFEFF
    try {
      const parsed = JSON.parse(ownManifestRaw.replace(/^\uFEFF/, ''))
      manifest = {
        parses: true,
        hasBom: manifest.hasBom,
        declaresBundle: parsed.dsh?.bundle?.patch !== undefined,
        filesIncludesPresets: Array.isArray(parsed.files) && parsed.files.includes('presets'),
      }
    } catch {
      manifest.parses = false
    }
  }

  const presetSourcePresent = await exists(join(root, 'presets', PRESET_ID, 'agent.cordis.yml'))
  const presetFlowSkillPresent = await exists(join(root, 'presets', PRESET_ID, 'skills', PRESET_ID, 'SKILL.md'))

  // 全局技能
  const skillDest = join(home, 'skills', SKILL_NAME)
  const skill = { dest: skillDest, present: false, owned: false, stale: false, markerVersion: null }
  if (await exists(skillDest)) {
    skill.present = true
    const marker = JSON.parse((await readIfPresent(join(skillDest, MARKER))) ?? 'null')
    skill.owned = marker?.package === 'dsh-story-mode'
    skill.markerVersion = marker?.version ?? null
    if (skill.owned) skill.stale = await skillDrift(join(root, 'skills', SKILL_NAME), skillDest)
  }

  // 旧安装残留：用户根下的同名模式
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
      ours: marker?.package === 'dsh-story-mode',
      isLink: legacyEntry.isSymbolicLink(),
    }
  }

  return {
    root,
    home,
    version,
    patch,
    manifest,
    presetInPackage,
    presetSourcePresent,
    presetFlowSkillPresent,
    viaProfile,
    profileState,
    skill,
    legacy,
    installer: join(root, 'scripts', 'install-links.mjs'),
  }
}

const PRESET_STATUS = {
  ok: '正常',
  missing: '**缺少 presets/short-story/**',
  'is-link': '**isDirectory() 为 false —— roster 会跳过**',
  incomplete: '**组成文件缺失或不可读**',
  'not-a-directory': '**不是目录**',
  'no-root': '**presets/ 目录不存在**',
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
    '## 一、模式（自动，由 cordis.patch.yml 接管）',
    '',
  ]

  if (!report.viaProfile) {
    lines.push('**本包不在任何 profile 的 `node_modules` 下。** patch 只在 profile 合成配置时被读到，')
    lines.push('所以现在不会有任何 roster 根被声明——模式不会出现。')
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
    lines.push(`| 包自己的 package.json 能解析 | ${report.manifest.parses ? '是' : '**否**'} |`)
    lines.push(`| package.json 无 BOM | ${report.manifest.hasBom ? '**有 BOM —— DSH 读不出 dsh.bundle**' : '是'} |`)
    lines.push(`| 声明了 dsh.bundle.patch | ${report.manifest.declaresBundle ? '是' : '**否**'} |`)
    lines.push(`| files 字段包含 presets | ${report.manifest.filesIncludesPresets ? '是' : '**否 —— 发出去的包会缺模式**'} |`)
    lines.push(`| cordis.patch.yml 存在 | ${report.patch.present ? '是' : '**否**'} |`)
    lines.push(`| 接管了 \`agent-presets\` 行 | ${report.patch.targetsRosterRow ? '是' : '**否**'} |`)
    lines.push(`| 重述了 includeShippedRoot / includeUserRoot | ${report.patch.restatesShippedRoots ? '是' : '**否 —— 会挤掉 shipped 预设**'} |`)
    lines.push(`| 用 require.resolve 定位本包 | ${report.patch.resolvesOwnPackage ? '是' : '**否**'} |`)
    lines.push(`| JS 段无行注释（折叠后会吃掉代码） | ${report.patch.hasLineComment ? '**有，必须删掉**' : '是'} |`)
    lines.push(`| 包内 presets/${PRESET_ID}/ | ${PRESET_STATUS[report.presetInPackage.status] ?? report.presetInPackage.status} |`)
    if (report.presetInPackage.pluginRow !== undefined && report.presetInPackage.pluginRow !== null) {
      lines.push(`| 组成里的插件行 \`${report.presetInPackage.pluginRow}\` 能解析到文件 | ${report.presetInPackage.pluginRowResolves ? '是' : '**否**'} |`)
    }
    lines.push('')

    if (!state.bundled) problems.push('包没被加进 profile 的 bundles，patch 不会生效')
    if (!report.manifest.parses) problems.push('package.json 解析失败（很可能是 BOM）')
    if (report.manifest.hasBom) problems.push('package.json 带 BOM，DSH 读不出 dsh.bundle 声明')
    if (!report.manifest.declaresBundle) problems.push('package.json 缺少 dsh.bundle 声明')
    if (!report.manifest.filesIncludesPresets) problems.push('files 字段不含 presets，发布出去会缺模式文件')
    if (!report.patch.present) problems.push('缺少 cordis.patch.yml，模式无人接管')
    if (!report.patch.targetsRosterRow) problems.push('patch 没有接管 agent-presets 行')
    if (!report.patch.restatesShippedRoots) problems.push('patch 没有重述 includeShippedRoot / includeUserRoot，会挤掉官方预设')
    if (!report.patch.resolvesOwnPackage) problems.push('patch 没有用 require.resolve 定位本包')
    if (report.patch.hasLineComment) problems.push('patch 的 JS 里有行注释，折叠后会吃掉后面的代码')
    if (report.presetInPackage.status !== 'ok') problems.push(`包内模式不完整（${report.presetInPackage.status}）`)
    if (report.presetInPackage.pluginRowResolves === false) problems.push('组成里的插件行解析不到文件')
    if (!report.presetSourcePresent) problems.push('包内缺少 presets/short-story/agent.cordis.yml')
    if (!report.presetFlowSkillPresent) problems.push('包内缺少写作流程技能')

    if (state.officialRosterPresent === true && problems.length === 0) {
      lines.push('**本包接管了官方的 `agent-presets` 行。** 它保留 `default: standard` 并把本包的')
      lines.push('`presets/` 追加为根，所以官方预设与本模式应当同时可见。')
      lines.push('')
      lines.push('代价要记住：补丁按 id 整体替换 `config`。升级 DSH 之后如果官方给这一行加了新')
      lines.push('字段，本包会静默抹掉它。对照命令：')
      lines.push('')
      lines.push('```sh')
      lines.push(`dsh --profile ${state.profile} --dump-default-config`)
      lines.push('```')
      lines.push('')
    }
  }

  // ── 技能 ──────────────────────────────────────────────────────────────────
  lines.push('## 二、全局技能（手动落地）', '')
  if (!report.skill.present) {
    lines.push(`- \`${report.skill.dest}\` 不存在 → 文风契约只在模式内生效（技能随模式走，模式里仍可用）。`)
    lines.push('- 想让它在**所有模式**下都生效，跑一次安装脚本。')
  } else if (!report.skill.owned) {
    lines.push(`- \`${report.skill.dest}\` 存在，但**不是本包装的** → 本包不会覆盖它。`)
  } else if (report.skill.stale) {
    lines.push(`- \`${report.skill.dest}\` **已过期**（与包内内容不一致）→ 跑一次安装脚本刷新。`)
    problems.push('全局技能已过期')
  } else {
    lines.push(`- \`${report.skill.dest}\` 正常（v${report.skill.markerVersion ?? '?'}，与包内一致）。`)
  }
  lines.push('')

  // ── 旧安装残留 ────────────────────────────────────────────────────────────
  lines.push('## 三、旧安装残留', '')
  if (!report.legacy.present) {
    lines.push('- 用户根下没有同名模式，干净。')
  } else if (report.legacy.ours) {
    lines.push(`- \`${report.legacy.path}\` 是本包**早期版本**留下的副本 → 会和 patch 声明的根撞 id，`)
    lines.push('  必须清掉，否则 roster 可能解析到过期的那一份。跑一次安装脚本即可。')
    problems.push('存在旧安装的模式副本')
  } else if (report.legacy.isLink) {
    lines.push(`- \`${report.legacy.path}\` 是符号链接，且不是本包当前的安装方式 → 建议清掉。`)
    problems.push('用户根下有可疑的链接副本')
  } else {
    lines.push(`- \`${report.legacy.path}\` 存在但**不是本包装的** → 已保留未动。`)
    lines.push('  注意它和本包的模式同名，roster 只会认其中一个。')
  }
  lines.push('')

  lines.push('## 结论', '')
  if (problems.length === 0) {
    lines.push('模式侧正常；技能侧见上。DSH 的 roster 会发现这个模式。')
    return lines.join('\n')
  }
  lines.push(`有 ${problems.length} 处需要处理：`, '')
  for (const problem of problems) lines.push(`- ${problem}`)
  if (problems.some((p) => p.includes('profile 已有官方'))) {
    lines.push('')
    lines.push('（上面这一条不是命令能修的——见第一节里的说明。）')
  }
  lines.push('')
  lines.push('能自动处理的（幂等，可反复执行）：', '', '```sh')
  lines.push(`node "${report.installer}"`)
  lines.push('```', '', '只检查不改动：', '', '```sh')
  lines.push(`node "${report.installer}" --check`)
  lines.push('```')
  return lines.join('\n')
}

/**
 * 构造自检工具定义。
 *
 * 用 `tool-kit` 的工厂，所以这个入口不依赖主入口——`dsh-story-mode/doctor`
 * 可以单独挂到任何模式里，不需要连带加载写作工具。
 */
export function doctorTool() {
  return makeTool({
    name: 'story_doctor',
    description: [
      'Verify how this package is installed and whether DSH can actually see its mode.',
      'The mode is delivered AUTOMATICALLY by the package\'s cordis.patch.yml, which declares a roster root pointing at the',
      'package\'s own presets/ directory, located at runtime with require.resolve. The package must sit under a profile\'s',
      'node_modules for that patch to be read at all. The global style-contract skill is delivered MANUALLY (copied into the',
      'skills root) and can therefore go stale.',
      'Reports per check: patch presence and shape, whether the in-package preset passes the framework\'s own discovery',
      'predicate (readdir + isDirectory — a symlink reads fine but the roster skips it), the skill\'s state, and any leftover',
      'copy from an earlier install that would collide on the preset id.',
      'Takes no arguments and changes nothing; it prints the exact commands to repair what it finds.',
    ].join(' '),
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '短篇小说模式安装自检', kind: 'read', rawInput: 'doctor' }),
    async run() {
      return renderDoctor(await runDoctor())
    },
  })
}

/** 独立挂载入口：只注册自检工具。 */
export function apply(ctx) {
  ctx.tools.register(doctorTool())
}
