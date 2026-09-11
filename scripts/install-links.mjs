/**
 * dsh-story-mode 辅助脚本：全局技能落地 + 旧安装清理。
 *
 * ── 现在的分工 ──────────────────────────────────────────────────────────────
 *
 * **模式由包的 `cordis.patch.yml` 自动接管**，不需要本脚本：装好包之后，
 * profile 启动时 patch 会用 `createRequire(ctx.baseUrl)` 问出本包装在哪，
 * 把包内的 `presets/` 声明为 roster 的一个根。卸载包，模式自动消失。
 *
 * 所以这个脚本只处理剩下两件事：
 *
 *   1. **全局技能**（`writing-style-contract`）。技能的发现根是固定的
 *      `<DSH_HOME>/skills`，插件没法往里声明一个根——它只接受"根下有个目录
 *      或平铺 md 文件"。所以那一份必须复制过去，本脚本负责落地与刷新。
 *   2. **清理旧安装**。本包的早期版本把模式**复制**进
 *      `<DSH_HOME>/.agent-presets/short-story`。那份副本现在会和 patch 声明的
 *      根撞 id，必须清掉，否则 roster 可能解析到过期的副本。
 *
 * ── 为什么是复制而不是符号链接 ──────────────────────────────────────────────
 *
 * 技能发现链（`dsh-skill-filesystem` 的 `nodeEntryKind`）其实是**跟随**符号
 * 链接的，所以链接本来能用。这里仍然选择复制，是为了让 `<DSH_HOME>/skills`
 * 下的内容一眼可见、并且卸载时能靠归属标记精确地只删自己那一份。
 *
 * 用法：
 *   node scripts/install-links.mjs              # 落地技能 + 清理旧模式副本
 *   node scripts/install-links.mjs --check      # 只报告，不改动；有待处理项时以 1 退出
 *   node scripts/install-links.mjs --uninstall  # 移除技能，并清理旧模式副本
 */
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const CHECK_ONLY = process.argv.includes('--check')
const UNINSTALL = process.argv.includes('--uninstall')

/** 本模式在 roster 里的 id，也是旧安装的目录名。 */
const PRESET_ID = 'short-story'
/** 全局技能名，也是它在技能根下的目录名。 */
const SKILL_NAME = 'writing-style-contract'
/** 归属标记：回答"这一份是谁装的"。 */
const MARKER = '.dsh-story-mode.json'

/** `<DSH_HOME>`：优先环境变量，否则 `~/.dsh`。 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  return join(homedir(), '.dsh')
}

const HOME = dshHome()
const SKILL_DEST = join(HOME, 'skills', SKILL_NAME)
const SKILL_SOURCE = join(PACKAGE_ROOT, 'skills', SKILL_NAME)
const LEGACY_PRESET_DEST = join(HOME, '.agent-presets', PRESET_ID)
const PRESET_IN_PACKAGE = join(PACKAGE_ROOT, 'presets')

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
 * 本包是不是装在某个 profile 的 `node_modules` 下。
 *
 * 这个判断决定模式归谁管：装在 profile 下 → `cordis.patch.yml` 会在启动时
 * 声明根，模式全自动；否则（例如从 clone 出来的目录直接用）没有 patch 生效，
 * 就得靠手动安装。
 */
function installedViaProfile() {
  const parts = PACKAGE_ROOT.replace(/\\/g, '/').split('/')
  return parts.some((part, index) => part === 'node_modules' && parts[index - 1] === 'profiles')
}

/** 目的地里是否有本包的归属标记。 */
async function ownedByUs(dest) {
  const parsed = JSON.parse((await readIfPresent(join(dest, MARKER))) ?? 'null')
  return parsed?.package === 'dsh-story-mode'
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

/** 两份目录内容是否一致（忽略归属标记）。 */
async function sameContent(a, b) {
  const [src, dest] = await Promise.all([listFiles(a), listFiles(b)])
  const left = src.filter((f) => f !== MARKER)
  const right = dest.filter((f) => f !== MARKER)
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
  for (const rel of left) {
    const [x, y] = await Promise.all([readFile(join(a, rel)), readFile(join(b, rel))])
    if (!x.equals(y)) return false
  }
  return true
}

/** 写归属标记。 */
async function writeMarker(dest) {
  let version = 'unknown'
  try {
    version = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    // 版本读不到不影响归属判定
  }
  await writeFile(join(dest, MARKER), `${JSON.stringify({
    package: 'dsh-story-mode',
    version,
    installedFrom: PACKAGE_ROOT,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
}

// ── 全局技能 ────────────────────────────────────────────────────────────────

/** 落地或刷新全局技能。 */
async function placeSkill() {
  if (!(await exists(join(SKILL_SOURCE, 'SKILL.md')))) {
    console.log(`  [错误] 全局技能: 包内源目录不完整 -> ${SKILL_SOURCE}`)
    return 'broken'
  }
  const destExists = await exists(SKILL_DEST)
  const owned = destExists ? await ownedByUs(SKILL_DEST) : false

  if (destExists && !owned) {
    console.log(`  [已存在] 全局技能: ${SKILL_DEST} 不是本包装的，不动它`)
    return 'blocked'
  }
  if (owned) {
    if (await sameContent(SKILL_SOURCE, SKILL_DEST)) {
      console.log('  [已就位] 全局技能')
      return 'ok'
    }
    if (CHECK_ONLY) {
      console.log('  [待刷新] 全局技能: 包内内容比已落地的那份新')
      return 'refreshed'
    }
    await rm(SKILL_DEST, { recursive: true, force: true })
    await cp(SKILL_SOURCE, SKILL_DEST, { recursive: true })
    await writeMarker(SKILL_DEST)
    console.log('  [已刷新] 全局技能')
    return 'refreshed'
  }
  if (CHECK_ONLY) {
    console.log(`  [缺失] 全局技能 -> 需要落地到 ${SKILL_DEST}`)
    return 'installed'
  }
  await mkdir(dirname(SKILL_DEST), { recursive: true })
  await cp(SKILL_SOURCE, SKILL_DEST, { recursive: true })
  await writeMarker(SKILL_DEST)
  console.log(`  [已落地] 全局技能 -> ${SKILL_DEST}`)
  return 'installed'
}

/** 移除本包落地的全局技能。 */
async function removeSkill() {
  if (!(await exists(SKILL_DEST))) {
    console.log('  [无内容] 全局技能')
    return 'absent'
  }
  if (!(await ownedByUs(SKILL_DEST))) {
    console.log(`  [保留] 全局技能: ${SKILL_DEST} 不是本包装的，不动它`)
    return 'keep'
  }
  await rm(SKILL_DEST, { recursive: true, force: true })
  console.log('  [已移除] 全局技能')
  return 'removed'
}

// ── 旧安装清理 ──────────────────────────────────────────────────────────────

/**
 * 判断 `<DSH_HOME>/.agent-presets/<id>` 是旧安装留下的，还是别的东西。
 *
 * 旧安装有两种形态：早期用符号链接，后来用复制（带归属标记）。
 * 用户手写的同名模式**没有**这两样特征，必须保留。
 */
async function legacyPresetKind() {
  if (!(await exists(LEGACY_PRESET_DEST)) && !(await lstat(LEGACY_PRESET_DEST).catch(() => null))) return 'absent'
  if (await ownedByUs(LEGACY_PRESET_DEST)) return 'ours-copy'
  const info = await lstat(LEGACY_PRESET_DEST).catch(() => null)
  if (info?.isSymbolicLink()) {
    const resolved = await realpath(LEGACY_PRESET_DEST).catch(() => null)
    if (resolved === null) return 'dangling-link'
    const lower = resolved.toLowerCase()
    if (lower.startsWith(PACKAGE_ROOT.toLowerCase()) || lower.includes('dsh-story-mode')) return 'our-link'
  }
  return 'foreign'
}

/**
 * 清理旧安装的模式副本。
 *
 * 必须清：patch 声明的根和用户根都提供同一个 id 时，roster 会解析到先扫到的
 * 那一个——留下过期的副本会让"改了包内文件但模式没变"这种故障发生。
 */
async function cleanLegacyPreset() {
  const kind = await legacyPresetKind()
  switch (kind) {
    case 'absent':
      console.log('  [无需清理] 旧模式副本不存在')
      return 'absent'
    case 'foreign':
      console.log(`  [保留] ${LEGACY_PRESET_DEST} 不是本包装的，不动它`)
      console.log('         （如果你自己写过同名模式，它和本包的模式会撞 id；建议改名）')
      return 'keep'
    case 'ours-copy':
    case 'our-link':
    case 'dangling-link': {
      if (CHECK_ONLY) {
        console.log(`  [待清理] 旧模式副本（${kind}）-> ${LEGACY_PRESET_DEST}`)
        return 'cleaned'
      }
      await rm(LEGACY_PRESET_DEST, { recursive: true, force: true })
      console.log(`  [已清理] 旧模式副本（${kind}）`)
      return 'cleaned'
    }
    default:
      return 'absent'
  }
}

// ── 悬空的默认预设 ──────────────────────────────────────────────────────────
//
// `AgentPresets.remove()` 会顺手清掉指向被删预设的用户默认值；卸载绕开那个
// 方法，所以必须自己清——否则 Web 端新建会话（不带显式 preset）会以
// `agent-preset/not-found` 直接失败。

async function readDefaultPreset() {
  const raw = await readIfPresent(join(HOME, 'settings.yaml'))
  if (raw === null) return null
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex((line) => /^agent-presets:\s*$/.test(line))
  if (start < 0) return null
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    if (/^\S/.test(line)) break
    const match = line.match(/^\s+default:\s*(.*?)\s*$/)
    if (match !== null) {
      const value = match[1].replace(/^['"]|['"]$/g, '')
      return value.length === 0 ? null : value
    }
  }
  return null
}

/** 清掉指向本模式的用户默认预设。只删那一行，其余逐字保留。 */
async function clearDanglingDefault() {
  const settings = join(HOME, 'settings.yaml')
  const current = await readDefaultPreset()
  if (current === null) return (await exists(settings)) ? 'unset' : 'absent'
  if (current !== PRESET_ID) return 'other'

  const lines = (await readFile(settings, 'utf8')).split(/\r?\n/)
  const start = lines.findIndex((line) => /^agent-presets:\s*$/.test(line))
  if (start < 0) return 'unset'

  const kept = [...lines]
  for (let i = start + 1; i < kept.length; i += 1) {
    const line = kept[i]
    if (line.trim().length === 0) continue
    if (/^\S/.test(line)) break
    if (/^\s+default:/.test(line)) {
      kept.splice(i, 1)
      break
    }
  }
  const blockStart = kept.findIndex((line) => /^agent-presets:\s*$/.test(line))
  if (blockStart >= 0) {
    let hasChild = false
    for (let i = blockStart + 1; i < kept.length; i += 1) {
      const line = kept[i]
      if (line.trim().length === 0) continue
      hasChild = !/^\S/.test(line)
      break
    }
    if (!hasChild) kept.splice(blockStart, 1)
  }
  await writeFile(settings, kept.join('\n'), 'utf8')
  return 'cleared'
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const mode = UNINSTALL ? '卸载' : CHECK_ONLY ? '检查' : '安装'
console.log(`dsh-story-mode ${mode}`)
console.log(`  包目录     ${PACKAGE_ROOT}`)
console.log(`  DSH 主目录  ${HOME}`)
console.log(`  模式归属   ${installedViaProfile() ? '由 profile 的 patch 自动接管（无需本脚本）' : '未装入 profile，模式需要单独处理'}`)
console.log('')

if (UNINSTALL) {
  const skill = await removeSkill()
  const legacy = await cleanLegacyPreset()
  const cleared = await clearDanglingDefault()
  console.log('')
  if (skill === 'keep') {
    console.log('全局技能不是本包装的，已保留未动。')
  } else {
    console.log('已清理：全局技能与旧模式副本。')
  }
  if (cleared === 'cleared') {
    console.log(`另外清掉了 settings.yaml 里指向 ${PRESET_ID} 的默认预设`)
    console.log('（不清的话，新建会话会以 agent-preset/not-found 失败）。')
  }
  console.log('')
  console.log('模式本身不需要清理：它住在包里，卸载包就没了。')
  console.log('  dsh plugin --profile <name> remove dsh-story-mode')
} else {
  const skill = await placeSkill()
  const legacy = await cleanLegacyPreset()
  const currentDefault = await readDefaultPreset()
  if (currentDefault === PRESET_ID) {
    console.log(`  [注意] 你的默认预设就是本模式；卸载前记得跑 uninstall 清掉它。`)
  }
  console.log('')

  const problems = [skill, legacy].filter((r) => r === 'broken' || r === 'blocked').length
  const pending = [skill, legacy].some((r) => r === 'installed' || r === 'refreshed' || r === 'cleaned')

  if (problems > 0) {
    console.log('有项目需要处理——见上面的提示。')
    process.exitCode = 1
  } else if (CHECK_ONLY && pending) {
    console.log('有待落地或待清理的项目。去掉 --check 运行即可完成。')
    process.exitCode = 1
  } else {
    console.log('就位。')
    if (installedViaProfile()) {
      console.log('模式由 profile 的 patch 自动接管——`dsh plugin add` 之后就生效，无需其他命令。')
      console.log('新会话即可在模式选择器里看到「短篇小说模式」。')
    } else {
      console.log('注意：本包不在 profile 的 node_modules 下，patch 不会生效，模式不会被发现。')
      console.log('请改用：dsh plugin --profile <name> add <本包>')
    }
    console.log('')
    console.log('卸载：一条命令就够（模式住在包里，跟着包走）：')
    console.log('  dsh plugin --profile <name> remove dsh-story-mode')
    console.log('全局技能不随包消失，需要时再跑一次 dsh-story-mode uninstall 清掉它。')
  }
}
