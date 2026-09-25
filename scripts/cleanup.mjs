/**
 * dsh-story-mode 辅助脚本：卸载前清理。**它不安装任何东西。**
 *
 * ── 这个包不往你的 home 里装东西 ────────────────────────────────────────────
 *
 * 模式是包自己 `cordis.patch.yml` 里**插入的一行 preset 声明**：子插件列表写在
 * 那一行的 `config.plugins` 里，技能由同一行用 `customSkillDirs` 从包内挂载。
 *
 * 所以 `dsh plugin add` 一步就完整可用，`dsh plugin remove` 一步就全部消失——
 * 两头都不需要本脚本，也没有"装完还要再跑一条命令"这回事。
 *
 * ── 两份技能为什么**不**落地到 <DSH_HOME>/skills ────────────────────────────
 *
 * 那是**用户根**（`skill-filesystem` 里 rank 400 的 `user-dsh`），而每个 preset
 * 自己挂的 skill-filesystem 实例都会扫它（`includeDefaultRoots` 默认 true）。
 * 往那儿放一份，等于让文风契约出现在**所有**模式里——包括编码会话。
 *
 * 它只属于写作模式，所以只从 preset 那一层挂载。技能注册表是宿主 + 按 scope
 * 分层的，preset 里那行注册进本 preset 的层；其他模式看不到它，也不该看到。
 *
 * ── 那本脚本还剩什么 ────────────────────────────────────────────────────────
 *
 * 三件 `dsh plugin remove` 管不到、或历史版本留下的东西：
 *
 *   1. **悬空的默认模式**。在模式选择器里把「短篇小说模式」设成默认之后再
 *      `dsh plugin remove`，新建会话会直接以 `agent-preset/not-found` 失败：
 *      注册表的 `resolve()`／`retain()` 找不到默认 id 时**不回退**到 `standard`，
 *      而会顺手清掉这个默认值的那条路径被卸载绕过了。
 *
 *      0.1.7 起这个默认值存在**用户自己选的** volatile 字段 `selectedDefault` 上，
 *      由 loader 写回它所在的那一层——实测落在 `<DSH_HOME>/profiles/<name>/cordis.patch.yml`
 *      的 `agent-preset-registry` 那一行（Web 配置编辑器也写在这里），home 级
 *      patch 同理。本脚本因此扫这些文件里的 `selectedDefault:`，命中就**只删那一行**
 *      （删掉即回落到部署默认值），不动同一条目里的其他字段。
 *
 *      所以**卸载前**跑一次本脚本（或者卸载后在模式选择器里改回 `standard`）。
 *
 *   2. **v1.0.1 的模式副本**。那个版本的 `install` 会把模式复制到
 *      `<DSH_HOME>/.agent-presets/short-story`。0.1.7 不再从目录发现预设，这一份
 *      已经不会被加载，但留着会让人以为"改了包内文件模式却没变"。
 *
 *   3. **用户根里的文风契约副本**。v1.0.1／v1.0.2 提供过一个可选的 install，
 *      往 `<DSH_HOME>/skills/writing-style-contract` 放一份。本包不再安装它，
 *      也不再推荐它（理由见上）。这一项**只在它带着本包的归属标记时**才删，
 *      所以绝不会误伤你自己手写的同名技能。
 *
 * 用法：
 *   node scripts/cleanup.mjs              # 清理上面三项
 *   node scripts/cleanup.mjs --check      # 只报告，不改动；有待处理项时以 1 退出
 *   node scripts/cleanup.mjs --uninstall  # 与不带参数等价（保留旧命令名）
 *
 * 包作为 profile 依赖安装时 bin 不在 PATH 上，用官方转发形式：
 *   dsh plugin --profile <name> exec dsh-story-mode cleanup
 */
import { lstat, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const CHECK_ONLY = process.argv.includes('--check')

/** 本模式的 preset id，也是旧安装的目录名。 */
const PRESET_ID = 'short-story'
/** 声明 preset 的注册表条目 id：用户默认值写在它的 config 里。 */
const REGISTRY_ROW_ID = 'agent-preset-registry'
/** 文风契约在技能根下的目录名。 */
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
const SKILL_COPY = join(HOME, 'skills', SKILL_NAME)
const LEGACY_PRESET = join(HOME, '.agent-presets', PRESET_ID)
const SETTINGS = join(HOME, 'settings.yaml')

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
 * 清理不依赖这个判断，它只是横幅里的一句事实——顺手告诉用户 patch 会不会生效。
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

// ── 用户根里的文风契约副本 ──────────────────────────────────────────────────

/**
 * 删掉本包以前放在用户根里的副本。
 *
 * 只在带归属标记时动手：那一份是本包放的，删它不会碰到用户手写的同名技能。
 * 没有标记就只报告——`.dsh/skills/` 是用户的目录，本包无权处置。
 */
async function removeSkillCopy() {
  if (!(await exists(SKILL_COPY))) {
    console.log('  [无内容] 用户根副本')
    return 'absent'
  }
  if (!(await ownedByUs(SKILL_COPY))) {
    console.log(`  [保留] 用户根副本: ${SKILL_COPY} 不是本包装的，不动它`)
    return 'keep'
  }
  if (CHECK_ONLY) {
    console.log(`  [待清理] 用户根副本（本包 v1.0.1/1.0.2 放的）-> ${SKILL_COPY}`)
    console.log('         删掉它文风契约就只在写作模式里生效；不删它会出现在所有模式。')
    return 'removed'
  }
  await rm(SKILL_COPY, { recursive: true, force: true })
  console.log('  [已移除] 用户根副本')
  return 'removed'
}

// ── v1.0.1 的模式副本 ───────────────────────────────────────────────────────

/**
 * 判断 `<DSH_HOME>/.agent-presets/<id>` 是旧安装留下的，还是别的东西。
 *
 * 旧安装有两种形态：早期用符号链接，后来用复制（带归属标记）。
 * 用户手写的同名模式**没有**这两样特征，必须保留。
 */
async function legacyPresetKind() {
  const info = await lstat(LEGACY_PRESET).catch(() => null)
  if (info === null) return 'absent'
  if (await ownedByUs(LEGACY_PRESET)) return 'ours-copy'
  if (info.isSymbolicLink()) {
    const resolved = await realpath(LEGACY_PRESET).catch(() => null)
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
      console.log(`  [保留] ${LEGACY_PRESET} 不是本包装的，不动它`)
      console.log('         （如果你自己写过同名模式，它和本包的模式会撞 id；建议改名）')
      return 'keep'
    case 'ours-copy':
    case 'our-link':
    case 'dangling-link': {
      if (CHECK_ONLY) {
        console.log(`  [待清理] 旧模式副本（${kind}）-> ${LEGACY_PRESET}`)
        return 'cleaned'
      }
      await rm(LEGACY_PRESET, { recursive: true, force: true })
      console.log(`  [已清理] 旧模式副本（${kind}）`)
      return 'cleaned'
    }
    default:
      return 'absent'
  }
}

// ── 悬空的默认模式 ──────────────────────────────────────────────────────────
//
// 注册表找不到默认 id 时不会回退到 `standard`；而卸载绕开了会顺手清掉这个
// 默认值的那条路径，所以必须自己清——否则新建会话（不带显式 preset）会以
// `agent-preset/not-found` 直接失败，而那时包已经被 remove、这个工具也没了。
// 所以这一段是**卸载前**跑的。

/**
 * 所有可能写着"用户默认模式"的文件。
 *
 * 0.1.7 把用户选择放在 `agent-preset-registry` 行的 volatile 字段
 * `config.selectedDefault` 上，由 loader 写回该条目所在的那一层：实测是
 * `<profile>/cordis.patch.yml`（Web 配置编辑器也写这里），home 级 patch 同理。
 * 逐 profile 扫一遍，是因为用户可能在任意一个 profile 里选过这个模式。
 */
async function defaultPresetFiles() {
  const files = []
  try {
    const profiles = await readdir(join(HOME, 'profiles'), { withFileTypes: true })
    for (const entry of profiles) {
      if (!entry.isDirectory()) continue
      const path = join(HOME, 'profiles', entry.name, 'cordis.patch.yml')
      if (await exists(path)) files.push(path)
    }
  } catch {
    // 没有 profiles 目录就只查 home 层
  }
  const homePatch = join(HOME, 'cordis.patch.yml')
  if (await exists(homePatch)) files.push(homePatch)
  return files
}

/**
 * 在一份 patch 文件里找"默认模式 = 本模式"的那一行。
 *
 * 只认两种写法，而且必须落在 `agent-preset-registry` 那一条目里：
 *   selectedDefault: <id>   → 删掉整行（回落到部署默认值）
 *   default: <id>           → 只能改值（这是必填字段，删了整行 schema 会失败）
 * 返回 null 表示这份文件不需要动。
 */
export function findDefaultPresetLine(raw, presetId = PRESET_ID) {
  const idPattern = new RegExp(`^['"]?${presetId}['"]?$`)
  let currentRow = null
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const rowMatch = lines[i].match(/^-\s*id:\s*(\S+)\s*$/)
    if (rowMatch !== null) {
      currentRow = rowMatch[1]
      continue
    }
    if (currentRow !== REGISTRY_ROW_ID) continue
    const fieldMatch = lines[i].match(/^(\s+)(selectedDefault|default):\s*(.*?)\s*$/)
    if (fieldMatch === null) continue
    if (!idPattern.test(fieldMatch[3].replace(/^['"]|['"]$/g, ''))) continue
    return { line: i, field: fieldMatch[2], indent: fieldMatch[1] }
  }
  return null
}

/** 旧位置：`<DSH_HOME>/settings.yaml` 里 `agent-presets:` 块下的那一行。 */
async function readLegacyDefaultPreset() {
  const raw = await readIfPresent(SETTINGS)
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

/**
 * 清掉指向本模式的用户默认值。
 *
 * 逐字保留文件其余部分：只删/改那一行，不重排、不重新序列化 YAML——
 * 这是**用户的** patch 层，本包无权重写它。
 */
async function clearDanglingDefault() {
  const targets = []
  for (const file of await defaultPresetFiles()) {
    const raw = await readIfPresent(file)
    if (raw === null) continue
    const hit = findDefaultPresetLine(raw)
    if (hit !== null) targets.push({ file, raw, hit })
  }
  const legacy = await readLegacyDefaultPreset()
  const legacyHit = legacy === PRESET_ID ? { file: SETTINGS, raw: null, hit: { field: 'default' } } : null

  if (targets.length === 0 && legacyHit === null) {
    if (legacy !== null) return { status: 'other', preset: legacy }
    return { status: 'unset' }
  }

  if (CHECK_ONLY) {
    for (const target of targets) {
      console.log(`  [待清理] ${target.file} 第 ${target.hit.line + 1} 行：${target.hit.field} = ${PRESET_ID}`)
    }
    if (legacyHit !== null) console.log('  [待清理] settings.yaml 的默认预设指向 ' + PRESET_ID)
    console.log('         不清的话，卸载包之后新建会话会以 agent-preset/not-found 失败。')
    return { status: 'cleared' }
  }

  for (const target of targets) {
    const lines = target.raw.split(/\r?\n/)
    if (target.hit.field === 'selectedDefault') {
      lines.splice(target.hit.line, 1)
    } else {
      // `default` 是注册表条目的必填字段：只把值换回部署默认值，不删行。
      lines[target.hit.line] = `${target.hit.indent}default: standard`
    }
    await writeFile(target.file, lines.join('\n'), 'utf8')
    console.log(`  [已清理] ${target.file}（${target.hit.field} → ${target.hit.field === 'selectedDefault' ? '回落部署默认值' : 'standard'}）`)
  }

  if (legacyHit !== null) {
    const lines = (await readFile(SETTINGS, 'utf8')).split(/\r?\n/)
    const start = lines.findIndex((line) => /^agent-presets:\s*$/.test(line))
    if (start >= 0) {
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
      // 整个块只剩 `agent-presets:` 一行时把它也去掉，别留孤零零的键。
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
      await writeFile(SETTINGS, kept.join('\n'), 'utf8')
      console.log('  [已清理] settings.yaml 的默认预设（旧位置）')
    }
  }
  return { status: 'cleared' }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

console.log(`dsh-story-mode ${CHECK_ONLY ? '检查' : '清理'}`)
console.log(`  包目录      ${PACKAGE_ROOT}`)
console.log(`  DSH 主目录  ${HOME}`)
console.log(`  模式归属    ${installedViaProfile() ? '由 profile 的 bundle patch 插入的 preset 声明行自动接管（本脚本不参与）' : '未装入 profile，patch 不会生效'}`)
console.log('')

const skill = await removeSkillCopy()
const legacy = await cleanLegacyPreset()
const cleared = await clearDanglingDefault()

const pending = [skill, legacy, cleared.status].some((result) => ['removed', 'cleaned', 'cleared'].includes(result))
console.log('')

if (skill === 'keep' || legacy === 'keep') {
  console.log('不是本包放的东西已原样保留，见上面的提示。')
}
if (cleared.status === 'other') {
  console.log(`用户选的默认模式是 ${cleared.preset}，不是本模式，卸载安全。`)
}

if (CHECK_ONLY && pending) {
  console.log('有待清理的项目。去掉 --check 运行即可完成。')
  process.exitCode = 1
} else {
  console.log('就位。模式本身不需要清理：它是包里 patch 插入的一行声明，卸载包就没了。')
  console.log('  dsh plugin --profile <name> remove dsh-story-mode')
}
