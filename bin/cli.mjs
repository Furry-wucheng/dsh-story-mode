#!/usr/bin/env node
/**
 * `dsh-story-mode` 命令行。
 *
 * 存在的理由是一个实测事实：**pnpm 默认忽略依赖的 postinstall 脚本**
 * （报 `ERR_PNPM_IGNORED_BUILDS`，需要用户手动 `pnpm approve-builds` 才放行）。
 * 所以"装完自动落地"这条路在 pnpm 下不成立。与其让用户去批准一个构建脚本
 * ——那是供应链风险习惯，不该为了省一条命令而养成——不如把落地做成一条
 * 显式命令：可见、可控、可重复。
 *
 * 用法：
 *   dsh-story-mode install     落地：把包内的模式与技能复制到 DSH 的发现根
 *   dsh-story-mode check       只检查，不改动；有内容待落地/待刷新时以 1 退出
 *   dsh-story-mode uninstall   移除已落地的内容
 *   dsh-story-mode help        帮助
 *
 * 选项：
 *   --dsh-home <路径>   覆盖 DSH 主目录（默认取 $DSH_HOME，否则 ~/.dsh）
 *   --force             覆盖已存在但不是本包落地的内容
 *
 * 也可以用 pnpm 直接跑，不必全局安装：
 *   pnpm dlx dsh-story-mode install
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const INSTALLER = join(PACKAGE_ROOT, 'scripts', 'install-links.mjs')

/** 吃掉 `--dsh-home <路径>`，其余参数当作子命令与标志。 */
function splitArgs(argv) {
  const rest = []
  let dshHome
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dsh-home') {
      dshHome = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--dsh-home=')) {
      dshHome = arg.slice('--dsh-home='.length)
      continue
    }
    rest.push(arg)
  }
  return { rest, dshHome }
}

const HELP = `dsh-story-mode —— 短篇小说模式（DeepSeek Harness）

用法：
  dsh-story-mode install       落地：把包内的模式与技能复制到 DSH 的发现根
  dsh-story-mode check         只检查，不改动；有内容待落地或待刷新时以 1 退出
  dsh-story-mode uninstall     移除已落地的内容
  dsh-story-mode help          显示这段帮助

选项：
  --dsh-home <路径>            覆盖 DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --force                      覆盖已存在但不是本包落地的内容

安装（官方方式）：
  dsh plugin --profile <name> add github:<你>/dsh-story-mode
  dsh plugin --profile <name> exec dsh-story-mode install

为什么还需要第二行：
  DSH 只在两个固定位置发现东西——<DSH_HOME>/.agent-presets/<id>/（模式）和
  <DSH_HOME>/skills/<name>/（技能）。插件安装体系（dsh plugin add →
  profile → bundle patch）只能往**宿主组成**插行，而模式是**文件**、由 roster
  从文件系统根发现——插件在结构上无法发布一个模式。所以这一步把包内的模式与
  技能**复制**到那两个位置。（升级包之后重跑一次即可刷新。）

  为什么是复制而不是符号链接：实测框架两处发现机制的判定不一致——
    * 模式：dsh-agent-presets 用 readdir().isDirectory() 判定候选，
      **不跟随链接**。Windows 上 Node 把 junction 报成符号链接，条目被直接跳过，
      模式不会出现在选择器里（而 stat() 读得到，所以看起来像"装好了没生效"）。
    * 技能：dsh-skill-filesystem 会跟随符号链接一级，链接本来能用。
  为了让两处行为一致、安装状态看得见，两者都复制。

install 是可重复执行的：内容一致就什么都不做，不一致才刷新。
本包旧版本用链接安装，install 会自动接管并换成真实目录。

卸载要两步（框架没有安装/卸载钩子，只能显式做）：
  1. dsh-story-mode uninstall                       移除已落地的内容
  2. dsh plugin --profile <name> remove dsh-story-mode
  只做第 2 步的话，模式会留在发现根里，看起来"卸载了但还在"。

装好之后：新建一个会话，在模式选择器里选「短篇小说模式」——不需要重启 DSH。
在会话里可以让 agent 调用 story_doctor 做一次自检。
`

const { rest, dshHome } = splitArgs(process.argv.slice(2))
const command = rest[0] ?? 'help'
const force = rest.includes('--force')

const env = { ...process.env }
if (dshHome !== undefined) env.DSH_HOME = dshHome

/** 把安装器的退出码原样带出去，脚本化使用才可靠。 */
function runInstaller(flags = []) {
  const result = spawnSync(process.execPath, [INSTALLER, ...flags], { stdio: 'inherit', env })
  process.exit(result.status ?? 1)
}

switch (command) {
  case 'install':
    runInstaller(force ? ['--force'] : [])
    break
  case 'check':
  case 'doctor':
    runInstaller(['--check'])
    break
  case 'uninstall':
  case 'remove':
    runInstaller(['--uninstall'])
    break
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(HELP)
    break
  default:
    process.stderr.write(`未知子命令：${command}\n\n${HELP}`)
    process.exit(1)
}
