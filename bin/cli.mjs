#!/usr/bin/env node
/**
 * `dsh-story-mode` 命令行：卸载前清理与自检。
 *
 * **它不安装任何东西。** 模式是包自己的 `cordis.patch.yml` 里**插入的一行 preset
 * 声明**（DSH 0.1.7 起注册表不扫描目录），子插件列表写在那一行的 `config.plugins`
 * 里；两份技能由同一行的 `customSkillDirs` 从包内挂载。`dsh plugin add` 一步就
 * 完整可用，`dsh plugin remove` 一步就全部消失。
 *
 * 技能**故意不**落地到 `<DSH_HOME>/skills`：那是用户根，每个 preset 的
 * skill-filesystem 实例都会扫它，放进去等于让它们出现在所有模式里（包括编码
 * 会话）。这两份技能只属于写作模式，所以只从 preset 那一层挂载。
 *
 * 那这个命令为什么还在？因为有三件事 `dsh plugin remove` 管不到：
 *
 *   1. **悬空的默认模式**。把「短篇小说模式」设成默认之后再 remove，新建会话会以
 *      `agent-preset/not-found` 直接失败——注册表的 `resolve()` 没有回退，而会顺手
 *      清掉这个默认值的那条路径被卸载绕过了。0.1.7 起这个默认值存在
 *      `<profile>/cordis.patch.yml` 的 volatile 字段里。
 *      这件事**必须在卸载前**做：包一旦 remove，这个命令也就没了。
 *   2. **v1.0.1 的模式副本**（`<DSH_HOME>/.agent-presets/short-story`）。
 *   3. **v1.0.1／v1.0.2 可能放过的用户根副本**（只删带本包归属标记的那一份）。
 *
 * 用法：
 *   dsh-story-mode check       只检查，不改动；有待清理项时以 1 退出
 *   dsh-story-mode cleanup     清理上面三项（不删不是本包放的东西）
 *   dsh-story-mode help        帮助
 *
 * 选项：
 *   --dsh-home <路径>   覆盖 DSH 主目录（默认取 $DSH_HOME，否则 ~/.dsh）
 *
 * 包作为 profile 依赖安装时 bin 不在 PATH 上，用官方转发形式：
 *   dsh plugin --profile <name> exec dsh-story-mode check
 *   dsh plugin --profile <name> remove dsh-story-mode
 *
 * 或者直接跑脚本（story_doctor 会打印本机上的确切路径）：
 *   node "<包目录>/scripts/cleanup.mjs" [--check]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const CLEANUP = join(PACKAGE_ROOT, 'scripts', 'cleanup.mjs')

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

const HELP = `dsh-story-mode —— 短篇小说模式（DeepSeek Harness 0.1.7-rc.1 及以后）

这个命令不安装任何东西：装包之后模式和两份技能都跟着包走——模式是包内
cordis.patch.yml 插入的一行 preset 声明，技能由那一行的 customSkillDirs 从包内
挂载。新建会话就能在模式选择器里选「短篇小说模式」；卸载包，它们一起消失。

它只做三件 dsh plugin remove 管不到的事（详见 scripts/cleanup.mjs 的文件头）：
  1. 清掉指向本模式的**用户默认模式**——不清的话，卸载后新建会话会直接
     以 agent-preset/not-found 失败。这一条必须在卸载**前**跑。
  2. 清掉 v1.0.1 复制到 <DSH_HOME>/.agent-presets/short-story 的模式副本。
  3. 清掉 v1.0.1／v1.0.2 可能放在 <DSH_HOME>/skills/writing-style-contract 的
     副本（带本包归属标记时才删），让技能只留在写作模式里。

用法：
  dsh-story-mode check       只检查，不改动；有待清理项时以 1 退出
  dsh-story-mode cleanup     执行清理（不删不是本包放的东西）
  dsh-story-mode help        显示这段帮助

选项：
  --dsh-home <路径>          覆盖 DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）

推荐顺序——先清理，再卸载：
  dsh plugin --profile <name> exec dsh-story-mode check
  dsh plugin --profile <name> exec dsh-story-mode cleanup
  dsh plugin --profile <name> remove dsh-story-mode

在会话里可以让 agent 调用 story_doctor 做一次自检（在写作模式里还会顺带报出
运行时的 roster、本作用域的技能与四个工具）。
`

const { rest, dshHome } = splitArgs(process.argv.slice(2))
const command = rest[0] ?? 'help'

const env = { ...process.env }
if (dshHome !== undefined) env.DSH_HOME = dshHome

/** 把清理脚本的退出码原样带出去，脚本化使用才可靠。 */
function runCleanup(flags = []) {
  const result = spawnSync(process.execPath, [CLEANUP, ...flags], { stdio: 'inherit', env })
  process.exit(result.status ?? 1)
}

switch (command) {
  case 'check':
  case 'doctor':
    runCleanup(['--check'])
    break
  case 'cleanup':
  case 'uninstall':
  case 'remove':
    runCleanup()
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
