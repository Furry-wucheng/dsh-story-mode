/**
 * 组合自检：把本包的 bundle 补丁当成 loader 那样读一遍。
 *
 * 面向 DSH 0.2.1-rc.1 及以后（在 0.2.1-rc.2 上实测）。
 *
 * 本包有**两层补丁、两个主模式**：`cordis.patch.yml`（完整版，五位角色化审读员）与
 * `cordis.lite.patch.yml`（精简版，一位合并审读员）。同一个脚本用 `--preset` 切档验证两者，
 * **检查逻辑一份都不复制**——两个档位的全部差异收在下面的 `PROFILES` 表里。所以"精简版也
 * 同等严格"不是靠补一套精简版检查换来的，而是同一套检查换一组期望值。
 *
 * 0.2.1 换代的地方：`@deepseek-ai/dsh-tool-subagent` 删掉了 `persona` / `toolFilter` /
 * `backgroundMode`（前两项是**硬报错**）。孩子的人设与工具面必须写在一个**命名的 agent
 * preset** 里，调度工具行只写 `agentPreset: <preset id>`；每次派发都是后台受管 activation，
 * 立即返回 childId，没有 `run_in_background` 参数。所以每份补丁插入的是**若干行 preset
 * 声明**，顺序固定：
 *
 *   `- insert:` → 审读员 preset 声明行（只读组合）… → 主模式 preset 声明行
 *
 * 主模式的 `config.plugins` 是模式的全部子插件；每个审读员声明行的 `config.plugins` 是
 * 那个角色的**完整工具面**（只挂 persona + tool-fs + tool-fs-search）。审读员的只读不再
 * 靠 `toolFilter` 名单，而是靠"写/编辑/交付/委派/技能/压缩工具根本没挂载"。
 *
 * 它回答的不是"文件能不能解析"，而是这些**只在装配时才会暴露**的问题：
 *   1. 每行的 `!!js` 能不能**编译**——语法错误要等到那一行挂载时才炸，而那一炸的表现
 *      是 preset 在 roster 里变成 broken、模式静默消失；
 *   2. `!!js` 里的值有没有被 YAML 转义改写（`'\n'` 在双引号标量里会变成真换行）；
 *   3. 双引号标量里有没有反斜杠转义（同一个坑的预防性检查）；
 *   4. 每行的 `config` 能不能过插件自己的 Config schema——审读员声明行与工具行都在内；
 *   5. **顺序**：审读员声明行必须排在主模式行之前——`tool-subagent` 在挂载时就校验
 *      `agentPreset` 指向的声明已经注册，倒序会让主模式整行 broken；
 *   6. **只读是组合保证的**：审读员 preset 里只有 persona + tool-fs（read/readImage 开、
 *      write/edit 关）+ tool-fs-search；挂回任何写/编辑/交付/委派/技能/压缩行都要报错；
 *   7. **agentPreset 指得到**：工具行的 `agentPreset` 必须等于某个已声明审读员 preset 的
 *      `config.id`；漏写就等于孩子继承主模式（拿到写文件与再委派）——这是本机制最危险的
 *      回归，因为它在装配时不报错、只让审读员悄悄拿到全部工具；
 *   8. **0.1.7 遗留字段为零**：整份补丁的 YAML 里不得出现 `toolFilter:` /
 *      `backgroundMode:`，`tool-subagent` 行不得带 `persona:`——前两项会让挂载失败或
 *      静默失效，后者是 0.2.1 的硬报错；
 *   9. 审读员人设是不是真来自它自己的文件（B4/合并那位还要按顺序拼上文风契约），
 *      以及这个补丁在**别的机器上**还装不装得上（行长不被插值、包内路径一律运行时解析）。
 *
 * 用法：node scripts/verify-composition.mjs [--preset <full|lite>] [--composition <file>]
 *   `--preset full`（默认）检 `cordis.patch.yml`，`--preset lite` 检 `cordis.lite.patch.yml`。
 *   退出码 0 = 全过；1 = 有失败项（打印到 stderr）。
 *   **档位必须显式给，脚本绝不按文件内容猜档**：两个主模式的 id／order／技能根／审读员
 *   工具名都不一样，猜档等于让校验器跟着被检对象走——把精简版的审读员行删光，也可能被
 *   "猜"成完整版之后报通过。默认 full 只是为了让仓库日常那条命令（`npm run verify:full`）
 *   不必带参数；`npm run verify:lite` 走的是 `--preset lite`。
 *
 * `--composition` 只为一件事：**在副本上验证失败路径**——把补丁改坏（截断、写回 `'\n'`、
 * 改错工具名、把审读员 preset 挂回写工具、删掉 `agentPreset`、把审读员行挪到主模式之后），
 * 脚本必须报错，而这些改动不该留在仓库里。
 * 它比 `--preset` 更具体：两者一起给时以它为准（档位只决定**期望值**，不决定读哪个文件）。
 *
 * 两件它**不能**代替的事：真实会话里的工具清单，以及审读子代理真的能起来。
 *
 * **它需要 harness**：插件源码、Config schema 与 loader 的 YAML 方言（js-yaml +
 * `entryListSchema`）都从 `@deepseek-ai/*` 取，而本包没有依赖、仓库里没有 node_modules。
 * 所以要么就在 harness 自己的进程里跑，要么用 `DSH_HARNESS=<harness 目录>` 指一个真实目录：
 *
 *   $env:DSH_HARNESS = "C:\Users\<你>\AppData\Local\Temp\dsh-e2e\dsh"
 *   node scripts/verify-composition.mjs
 *
 * 桌面版把 harness 装在 Electron 的 `resources/app.asar` 里，而**普通 Node 读不了 asar
 * 内部的模块路径**（那是 Electron 才认识的补丁），所以必须先把那一层运行时解压成真实目录。
 * 找不到 harness 时这个脚本会直接报错退出——不静默降级：它的价值全在"用真实的插件与
 * 真实的解析器校验"，拿不到就必须说自己不可信。
 *
 * **零依赖**（和这个包本身一样）：自带一个只认补丁文件实际用到子集的 YAML 读取器
 * ——顶层补丁条目（`- insert:`）、嵌套的插件行、`key: value`、`|-` 字面块标量、
 * `- 值` 标量序列、`[...]` 流序列、`#` 注释和 `!!js` 标量标记。它是**校验器**不是
 * 通用解析器：遇到不认识的形状直接报错退出，而不是猜。**但它不做 YAML 转义**，所以凡是
 * "值里可能出现转义"的判断，都必须以 loader 自己的解析器（js-yaml + `entryListSchema`）
 * 为准——第 1c 节就是为此存在的，v1.1.3 正是栽在只有那个解析器才看得出的错误上。
 *
 * 还有一件只能靠运行时才知道的事：`!!js` 求值时的 `baseUrl` 是 **profile 目录**，
 * 不是包目录（见文件头第 2/3 条），所以包内路径全是
 * `createRequire(baseUrl).resolve('dsh-story-mode/package.json')` 问出来的。第 1d 节
 * 为此搭了一个临时目录 + junction，让这些表达式**真的跑一遍**——不搭的话它们只会
 * MODULE_NOT_FOUND，而脚本也就查不出"文件到底在不在"。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
// 目录形式的 baseUrl 必须带**尾分隔符**，否则 Node 会把目录当成文件解析。
// 这里绝不能用 `join(...) + '\\'`：反斜杠只是 Windows 的分隔符，在 macOS／Linux
// 上它会被当成文件名的一部分，路径会变成 `<root>/skills/...` 这类错位置，五个
// 审读员的 `!!js` 全部 ENOENT——看起来像"行坏了"，实际是自检脚本自己走错目录
// （v1.2.1 修过一次这个 bug）。统一用 `pathToFileURL(dir + sep)`。

// ── 报告通道 ────────────────────────────────────────────────────────────────
//
// 走同步写而不是 console.log + process.exit：管道上 stdout 是异步写，
// `process.exit()` 会把还没冲出去的失败信息截掉——而"失败必须看得见"正是这个脚本的意义。
const failures = []
const notes = []
const fail = (message) => failures.push(message)
function emit(fd, text) {
  try {
    writeSync(fd, `${text}\n`)
  } catch { /* 输出管道没了也只能认了 */ }
}
const out = (text) => emit(1, text)
const err = (text) => emit(2, text)
const die = (message) => {
  err(`[FAIL] ${message}`)
  process.exit(1)
}

/**
 * 人设片段：`file` 是包内路径（`join(ROOT, …)` 解出来），`label` 只在报告里用。
 *
 * 一个人设 = 这些片段**按数组顺序**用换行拼起来（补丁里那句 `String.fromCharCode(10)`）。
 * 顺序不是装饰：契约的使用说明要求"先读作者要求、再完整读正文、最后对照契约"，而 persona
 * 在 system prompt 最前、正文才是用户消息——所以角色说明必须在契约之前，拼反了要报错。
 * `label` 默认取文件名（完整版五位角色的既有输出就是这样）；两个片段同名时才显式给路径。
 */
const personaPart = (file, label) => ({ file: join(ROOT, file), label: label ?? basename(file) })

// ── 档位表 ──────────────────────────────────────────────────────────────────
//
// 两层补丁的**全部差异**都在这里：上面的检查逻辑一份都不复制，只按档位取期望值。加第三层
// 补丁 = 在这里加一档，不改逻辑。表里每一条都对应"只在装配时才会暴露"的一个问题，理由写在
// 条目旁边——精简不等于放松，它是另一组同样具体的期望值（例如审读员**刻意**只有一位）。
//
// 每档描述"这个 patch 应该长什么样"：
//   * `main`      主模式声明：`rowId`（loader 行 id，profile 的补丁按它覆写 config）、
//                 `presetId`（config.id，会话日志与 agentPreset 按它走）、order、技能根、
//                 入口技能、必须存在/刻意不要的行；
//   * `reviewers` 每个只读审读员：自己的声明行 `rowId`、`config.id`（= 工具行的
//                 `agentPreset`）、order、名字里必须出现的角色标记、对应的工具名，以及
//                 persona 的**拼装顺序**（数组顺序 = 挂载时的拼接顺序）。
//
// 档位由命令行显式给出（`--preset`），**绝不按文件内容猜**：两个主模式的 id／order／技能根／
// 审读员工具名都不同，猜档等于让校验器跟着被检对象走。默认 full 是刻意的：仓库日常跑的就是它。
const PROFILES = {
  full: {
    patch: 'cordis.patch.yml', // 不给 --composition 时检哪一份
    main: {
      rowId: 'preset-short-story', // loader 行 id：profile 的补丁按它覆写 config
      presetId: 'short-story', // config.id：会话日志与技能索引按它走
      order: 5, // 官方预设占 1–4
      nameHint: null, // 主模式的名字只要求非空（措辞可以改）
      // 通用出口：**不写** agentPreset，孩子加入父代理当前的 preset 修订（"再找一双眼睛"）。
      genericToolName: 'subagent',
      // 技能根 → 该根下必须读得到的技能文件（相对该根）。根自己就是技能目录时文件写
      // `SKILL.md`：skill-filesystem 扫根时目录取 `<目录>/SKILL.md`、文件取它自己。
      skillRoots: [
        {
          // 完整版一个根装两份技能：`short-story`（流程）与 `writing-style-contract`（文风契约）。
          // 契约只从这里挂——放进用户根（`<DSH_HOME>/skills`）会让它出现在所有模式里，包括编码会话。
          dir: 'skills',
          label: '包内 skills/',
          skills: ['short-story/SKILL.md', 'writing-style-contract/SKILL.md'],
        },
      ],
      // 少一行 send_message / list_agents 就少一件工具，审读员复用不起来。
      requiredRowNames: [
        '@deepseek-ai/dsh-tool-subagent-control',
        '@deepseek-ai/dsh-tool-subagent-control/list-agents',
      ],
      // 完整版不禁止任何工具行：查证（`tool-web`）与长程目标（`tool-goal`）在这里是功能。
      forbiddenRowNames: [],
      // 入口技能里必须能读到的两句新契约（0.2.1 的派发语义）：每行都要能检出。
      entrySkill: 'skills/short-story/SKILL.md',
    },
    // 五条审读员声明 + 五条工具行：**角色人设只在自己的文件里**，由那个 preset 的 persona
    // 在挂载时读出来。`persona` 数组的顺序就是拼接顺序（多片段用换行连接）。
    reviewers: [
      {
        rowId: 'preset-short-story-review-b1',
        presetId: 'story-review-b1',
        order: 101,
        nameHint: 'B1',
        toolName: 'subagent_review_b1',
        persona: [personaPart('skills/short-story/references/reviewers/b1-cold-read.md')],
      },
      {
        rowId: 'preset-short-story-review-b2',
        presetId: 'story-review-b2',
        order: 102,
        nameHint: 'B2',
        toolName: 'subagent_review_b2',
        persona: [personaPart('skills/short-story/references/reviewers/b2-story-logic.md')],
      },
      {
        rowId: 'preset-short-story-review-b3',
        presetId: 'story-review-b3',
        order: 103,
        nameHint: 'B3',
        toolName: 'subagent_review_b3',
        persona: [personaPart('skills/short-story/references/reviewers/b3-reading-experience.md')],
      },
      {
        rowId: 'preset-short-story-review-b4',
        presetId: 'story-review-b4',
        order: 104,
        nameHint: 'B4',
        toolName: 'subagent_review_b4',
        // **只有 B4** 多拼一份文风契约——契约是给"文风执行"这个维度的判据，其余四位拿它
        // 只会多一段每轮都发的前缀。
        persona: [
          personaPart('skills/short-story/references/reviewers/b4-style-execution.md'),
          personaPart('skills/writing-style-contract/SKILL.md', 'writing-style-contract/SKILL.md'),
        ],
      },
      {
        rowId: 'preset-short-story-review-b5',
        presetId: 'story-review-b5',
        order: 105,
        nameHint: 'B5',
        toolName: 'subagent_review_b5',
        persona: [personaPart('skills/short-story/references/reviewers/b5-physical-continuity.md')],
      },
    ],
    reviewerToolNameHint: 'subagent_review_b1…b5',
    // 五个角色工具在精简版里不存在；完整版当然可以有。
    forbiddenReviewerPattern: null,
  },
  lite: {
    patch: 'cordis.lite.patch.yml',
    main: {
      rowId: 'preset-short-story-lite', // 与完整版的 id 必须成对唯一：loader 按行 id 建表，
      presetId: 'short-story-lite', // 撞了是**静默**的（后面的覆盖前面的，一个模式无声消失）
      order: 6, // 完整版占 5，精简版排在它后面
      nameHint: '精简', // roster 里必须自报精简档（「短篇小说模式（精简）」）
      genericToolName: 'subagent',
      // **两个根，各自只装该装的那一份**：
      //   `skills-lite/`                   精简流程技能（只有 `short-story-lite/`）
      //   `skills/writing-style-contract/` 文风契约（与完整版共用同一份文件）
      // 第二个根指向契约**目录本身**：扫描根时目录取 `<目录>/SKILL.md`，所以指向它就能把契约
      // 单独挂进来，不必复制一份、也不会产生第二份会漂移的契约。这样精简会话的技能清单里
      // **没有**完整版的 `short-story` 技能——否则模型会去用它那些本模式不存在的角色工具。
      skillRoots: [
        {
          dir: 'skills-lite',
          label: '包内 skills-lite/',
          skills: ['short-story-lite/SKILL.md'],
        },
        {
          dir: join('skills', 'writing-style-contract'),
          label: '包内 skills/writing-style-contract/',
          skills: ['SKILL.md'],
        },
      ],
      requiredRowNames: [
        '@deepseek-ai/dsh-tool-subagent-control',
        '@deepseek-ai/dsh-tool-subagent-control/list-agents',
      ],
      // 砍掉的几行都是"每轮都在前缀里"的常驻成本（`tool-web` 2 个、`tool-goal` 3 个 schema）。
      // `command-goal` **必须连它一起砍**：它只注册 `/goal`，而读/建/标记目标的工具全在
      // `tool-goal` 里；只留命令会让宿主把目标置为 armed、却没有任何工具能收回来。
      // 设计上不要它们，所以行级钉住：加回来会被拦，而不是被当成新功能放行。
      // （工具名住在这些行所属的包里，行级禁入比逐个工具名对账更直接、也不会漏。）
      forbiddenRowNames: [
        '@deepseek-ai/dsh-tool-web',
        '@deepseek-ai/dsh-tool-goal',
        '@deepseek-ai/dsh-command-goal',
      ],
      entrySkill: 'skills-lite/short-story-lite/SKILL.md',
    },
    // **一位读者，五个维度。** 人设 = 合并审读员说明 + 文风契约全文，顺序与完整版 B4 相同
    // （角色说明在前、契约在后）。
    reviewers: [
      {
        rowId: 'preset-short-story-review-merged',
        presetId: 'story-review-merged',
        order: 111,
        nameHint: '合并',
        toolName: 'subagent_review',
        persona: [
          personaPart('skills-lite/references/reviewer-merged.md'),
          personaPart('skills/writing-style-contract/SKILL.md', 'writing-style-contract/SKILL.md'),
        ],
      },
    ],
    reviewerToolNameHint: 'subagent_review（精简版只有这一位合并审读员）',
    // 五个角色工具在精简版里不存在（技能也不再提它们，只提"本模式没有的角色工具"）。
    // 注意**不能**拿原文正则去扫 `subagent_review_b`：补丁注释里就写着"本模式没有的
    // `subagent_review_b*` 工具"这类解释——扫原文会把正确的注释判成错误。
    // 所以只扫**解析后的工具名**：那是真会被注册、真会被派发的名字。
    forbiddenReviewerPattern: /^subagent_review_b\d+$/,
  },
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

/**
 * 只认两个开关：`--preset <full|lite>` 选期望值档位，`--composition <file>` 选被检文件。
 *
 * 两个都要**扫完全部参数**（老版本遇到 `--composition` 就 return，于是 `--composition X
 * --preset lite` 里那个 `--preset` 会被静默丢掉——而 `npm run verify:lite` 正是这个顺序）。
 * 拼写错的值一律 die：档位不明时"用默认档位凑合"是这里最坏的失败形态——期望值与被检对象
 * 对不上，脚本会对着精简版报一堆完整版的错，或者更糟：报通过。
 */
function optionsFromArgv(argv) {
  let composition = null
  let preset = 'full'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--composition' || arg === '--preset') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0) {
        die(arg === '--preset' ? '--preset 后面要跟一个档位（full 或 lite）' : '--composition 后面要跟一个补丁文件路径')
      }
      if (arg === '--preset') preset = value
      else composition = resolve(value)
      index += 1
      continue
    }
    if (arg.startsWith('--composition=')) {
      const value = arg.slice('--composition='.length)
      if (value.length === 0) die('--composition= 后面要跟一个补丁文件路径')
      composition = resolve(value)
      continue
    }
    if (arg.startsWith('--preset=')) {
      const value = arg.slice('--preset='.length)
      if (value.length === 0) die('--preset= 后面要跟一个档位（full 或 lite）')
      preset = value
      continue
    }
    die(`不认识的参数 ${arg}（只支持 --composition <file> 与 --preset <full|lite>）`)
  }
  return { composition, preset }
}

const OPTIONS = optionsFromArgv(process.argv.slice(2))
const PROFILE = PROFILES[OPTIONS.preset]
if (PROFILE === undefined) {
  die(`不认识的 --preset 值 ${JSON.stringify(OPTIONS.preset)}（只支持 ${Object.keys(PROFILES).join('、')}）`)
}
// 档位只决定**期望值**；被检文件永远是 `--composition` 说的那一份（没给才按档位的默认文件）。
// 两者不匹配时所有的行/路径检查都会报错，不需要额外的一致性猜测逻辑。
const COMPOSITION = OPTIONS.composition ?? join(ROOT, PROFILE.patch)

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

/** 已读到的条目数——三者用途不同，分开记。 */
let rowEntriesRead = 0 // 所有 `- id:` 行（含 preset 声明行与分组子行）
let patchEntriesRead = 0 // 补丁文件顶层的 `- <key>:` 条目
let scalarItemsRead = 0 // `- 值` 形式的标量序列项（例如 customSkillDirs）

/**
 * 块标量正文占用的行号区间（0 基，闭区间）。
 *
 * "文件里有多少个行首 `- `"这条交叉检查要用它把块标量正文排除掉：人设正文里出现一行
 * Markdown 列表不是新条目，把它算成条目会让脚本对着正确的文件报错。
 */
const blockScalarRanges = []

/** 读取 `|-` / `>-` 之类的块标量，返回 [文本, 下一个行号]。 */
function readBlockScalar(lines, index, cursor, folded) {
  const first = index
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
  if (index > first) blockScalarRanges.push([first + 1, index])
  return [folded ? collected.join(' ').trim() : collected.join('\n'), index]
}

/**
 * 从 `from` 起第一条**有内容**的行（空行与整行注释都跳过）。
 *
 * `key:` 后面挂的是什么形状，只能看紧跟其后的第一条内容行——中间夹几行注释是常态
 * （组合里每个插件行前面都有一段说明），把注释行当成子块的开头会让读取器把 `- id: …`
 * 读成 `- id` 这个键，然后在下一行的缩进上炸掉（v1.1.4 的读取器就是这么挂的）。
 */
function firstContentLine(lines, from) {
  for (let index = from; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    const text = stripComment(raw.slice(indent))
    if (text.trim() === '') continue
    return { index, indent, text }
  }
  return null
}

/**
 * 已经消费到的最远行号。
 *
 * 这个读取器只认补丁实际用到的 YAML 子集，所以"少读/重复读一行"是它最危险的
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

/**
 * 读取块序列。三种模式：
 *   `rows`    插件行（必须有 `id`）；
 *   `patches` 顶层补丁条目（`- insert:`，没有 id，也不该有别的形状）；
 *   `scalars` `- 值` 形式的标量序列。
 */
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
        const child = firstContentLine(lines, index + 1)
        if (child !== null && child.indent > cursor) {
          // `- 值`（没有 `key:`）是标量序列；`- id: …` 才是插件行。
          const childMode = child.text.startsWith('- ') && !/^-\s+[\w-]+\s*:/.test(child.text) ? 'scalars' : 'rows'
          const [nested, next] = child.text.startsWith('- ')
            ? parseRows(lines, child.index, child.indent, childMode)
            : parseMapping(lines, child.index, child.indent)
          row[key] = nested
          index = Math.max(next - 1, index)
          if (index < child.index) index = child.index
          continue
        }
        row[key] = ''
        continue
      }
      row[key] = parseScalar(rest, `第 ${index + 1} 行`)
    }
    if (mode === 'patches') {
      // 顶层条目是**补丁**不是插件行：它没有 id，只有 insert（以及各字段覆写）。
      // 既没有 insert 也没有 id 的条目说明这个读取器已经不认识文件了，直接失败。
      if (!('insert' in row) && !('id' in row)) {
        throw new YamlSubsetError(`第 ${index + 1} 行附近：顶层补丁条目既没有 insert 也没有 id，读取器不认识这种形状`)
      }
      rows.push(row)
      patchEntriesRead += 1
      continue
    }
    // 组合的每一行都必须有 id：没有 id 的条目只能是嵌套序列（例如 customSkillDirs），
    // 把它当成行会让"行数对不对"的检查失去意义，所以这里直接失败。
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new YamlSubsetError(`第 ${index + 1} 行附近：缩进 ${indent} 的条目没有 id，说明读取器把嵌套序列当成了插件行`)
    }
    rows.push(row)
    rowEntriesRead += 1
    if (process.env.VERIFY_TRACE === '1') err(`  [row ${rowEntriesRead}] line ${index + 1} id=${row.id}`)
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
      const child = firstContentLine(lines, index + 1)
      if (child !== null && child.indent > indent) {
        const childMode = child.text.startsWith('- ') && !/^-\s+[\w-]+\s*:/.test(child.text) ? 'scalars' : 'rows'
        const [nested, next] = child.text.startsWith('- ')
          ? parseRows(lines, child.index, child.indent, childMode)
          : parseMapping(lines, child.index, child.indent)
        map[key] = nested
        // 永远向前走：嵌套解析器在原地返回时，至少跨过刚看的那一行。
        index = Math.max(next, child.index + 1)
        continue
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

/** 顶层是**补丁列表**（`- insert:`），不是插件行列表。 */
function parsePatchFile(text) {
  return parseRows(text.replace(/^\uFEFF/, '').split(/\r?\n/), 0, 0, 'patches')[0]
}

// ── 1. 读并解析 ─────────────────────────────────────────────────────────────

const raw = (() => {
  try {
    return readFileSync(COMPOSITION, 'utf8')
  } catch (error) {
    // 路径写错时要说清楚是**哪一个**文件，而不是抛一个只有 errno 的栈。
    return die(`补丁文件读不动 ${COMPOSITION}：${error.message}`)
  }
})()
let patchEntries
try {
  patchEntries = parsePatchFile(raw)
} catch (error) {
  die(`组合读不动：${error.message}`)
}
if (patchEntries.length === 0) die('补丁文件里一个顶层条目都没读出来——空文件不是"没有补丁"')
// 读取器只认子集；形状对不上时必须响亮地失败，而不是少读几行之后报"通过"。
// 计数用 `[ \t]*` 而不是 `\s*`：多行模式下 `\s` 会跨行吞掉换行，把整份文件读成 0 条。
const declaredInserts = (raw.match(/^[ \t]*- insert:/gm) ?? []).length
if (declaredInserts !== patchEntriesRead) {
  die(`YAML 读取器读到的补丁条目数与文件不符：文件里 ${declaredInserts} 个 "- insert:"，读出 ${patchEntriesRead} 个`)
}
const declaredRows = (raw.match(/^[ \t]*- id:/gm) ?? []).length
if (declaredRows !== rowEntriesRead) {
  die(`YAML 读取器读到的行数与文件不符：文件里 ${declaredRows} 个 "- id:"，读出 ${rowEntriesRead} 个`)
}
// 更强的一条：**所有**行首 `- ` 条目都要有归属（补丁条目／插件行／标量序列项）。
// 少一条就说明读取器跳过了文件里真实存在的一行——那正是"部分解析也报通过"的入口。
const dashLineIndexes = raw.split(/\r?\n/)
  .map((line, index) => (/^[ \t]*- /.test(line)
    && !blockScalarRanges.some(([from, to]) => index >= from && index <= to) ? index : -1))
  .filter((index) => index >= 0)
const entriesRead = rowEntriesRead + patchEntriesRead + scalarItemsRead
if (dashLineIndexes.length !== entriesRead) {
  die(`YAML 读取器没读完文件：行首 "- " 条目 ${dashLineIndexes.length} 个，只读出 ${entriesRead} 个`
    + `（插件行 ${rowEntriesRead} + 补丁条目 ${patchEntriesRead} + 标量项 ${scalarItemsRead}）`)
}
notes.push(`组合 ${COMPOSITION}：补丁条目 ${patchEntriesRead} 个、行 ${rowEntriesRead} 行（含 preset 声明行与分组子行）、`
  + `标量序列项 ${scalarItemsRead} 个`)

// ── 1b. 找 harness（插件源码、Config schema、loader 的 YAML 方言都从它取）────

/**
 * 找 `@deepseek-ai/*` 的地方。
 *
 * 本包**没有依赖**（连 schemastery 都不 import），所以仓库里没有 node_modules 可查；
 * 而那些插件装在 harness 自己的 node_modules 下。顺序是：脚本自己解析得到的位置
 * → `DSH_HARNESS=<harness 目录>` → 桌面版的默认安装路径。**找不到就报错，不静默降级**：
 * 这个脚本的价值全在"用真实的插件与真实的解析器校验"，拿不到就必须说自己不可信。
 *
 * 桌面版的 harness 住在 Electron 的 `resources/app.asar` 里，而**普通 Node 读不了 asar
 * 内部的模块路径**（`createRequire` 会一路 MODULE_NOT_FOUND，asar 是 Electron 的补丁
 * 才认识的东西）。要跑这个脚本，先把那一层运行时解压成真实目录，再指过来。
 */
function resolveHarnessRequire() {
  const candidates = []
  // 在 harness 自己启动的进程里（或装了 workspace 链接时），这一条就能命中；仓库里没有
  // node_modules 时它会解析失败——仍然列进"试过的位置"，好让失败信息说的是实话。
  candidates.push({ require: createRequire(import.meta.url), label: '脚本自身的解析路径' })
  const explicit = process.env.DSH_HARNESS
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const directory = resolve(explicit.trim())
    candidates.push({
      require: createRequire(pathToFileURL(join(directory, 'package.json')).href),
      label: `DSH_HARNESS=${directory}`,
    })
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
  err('[FAIL] 找不到 harness 的 node_modules，无法读取插件源码、Config schema 与 loader 的 YAML 方言。')
  err('  用 DSH_HARNESS=<harness 目录> 指给它，例如：')
  err('    $env:DSH_HARNESS = "C:\\Users\\<你>\\AppData\\Local\\Temp\\dsh-e2e\\dsh"')
  err('  注意：harness 若只存在于 Electron 的 app.asar 里，普通 Node 读不了 asar 内部的模块路径，')
  err('  必须先把那一层运行时解压成真实目录（解出来的目录里应当有 package.json 与 node_modules）。')
  err(`  试过的位置：${harness.candidates.map((candidate) => candidate.label).join('、')}`)
  process.exit(1)
}
const harnessRequire = harness.found[0].require
notes.push(`插件源码与解析器来自：${harness.found[0].label}`
  + `${harness.found.length > 1 ? `（另有 ${harness.found.length - 1} 处同样可用）` : ''}`)

// ── 1c. 与 loader 同款解析器交叉验证 ────────────────────────────────────────
//
// v1.1.3 的事故就藏在这一步：`persona: !!js "… return role + '\n' + contract; …"`
// 里的 `\n` 被 **YAML 双引号标量**先解析成真正的换行符，JS 源码于是跨行、编译报
// `Invalid or unexpected token`——而 preset 挂载失败会让 roster 里那一条变成 broken，
// 文件形状却完全合法。**本脚本自己的读取器不做 YAML 转义**，所以它当时看不出问题。
// 凡涉及"值里出现转义"的判断，都必须以 loader 的解析器为准。
function loadLoaderDialect() {
  try {
    const jsYaml = harnessRequire('js-yaml')
    const include = harnessRequire('@deepseek-ai/cordis-plugin-include')
    if (typeof include.entryListSchema === 'undefined') return { error: 'entryListSchema 未导出' }
    return { load: jsYaml.load, schema: include.entryListSchema }
  } catch (error) {
    return { error: error.message }
  }
}

/** 取出一行 config 里所有 `!!js` 表达式（标记对象或数组元素都可能带）。 */
function jsExprs(value, found = []) {
  if (value instanceof Object && '__jsExpr' in value) found.push(value.__jsExpr)
  else if (Array.isArray(value)) for (const item of value) jsExprs(item, found)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) jsExprs(item, found)
  return found
}
const isJsExpr = (value) => value instanceof Object && '__jsExpr' in value

/**
 * 只编译、不执行：把一个 `!!js` 表达式按**表达式位置**编出来。
 *
 * 这一句是"语法错误必须在自检里报掉"的全部实现：`new Function(…)` 只编译不调用，
 * 所以对一个要读文件的表达式也不会产生副作用。用严格模式 + `return (…)` 是刻意的——
 * v1.1.3 那种被 YAML 转义改成跨行字符串字面量的源码，正是在这里报
 * `Invalid or unexpected token`。真正的求值在 1d 用 loader 自己那套形式做。
 */
function compileExpression(source) {
  // `baseUrl` 走参数而不是外层作用域：严格模式下的 `new Function` 不会闭包捕获
  // 模块作用域的绑定，写成自由变量会直接 ReferenceError。
  return new Function('ctx', 'baseUrl', 'process', `"use strict"; return (${source});`)
}

/** 摊平一行行：分组行（`group: true`）递归进它的 `config`，路径拼成 `分组/子行`。 */
function flattenRows(list, prefix) {
  const flat = []
  for (const row of list ?? []) {
    const at = prefix === '' ? row.id : `${prefix}/${row.id}`
    flat.push({ at, row, group: row.group === true })
    if (row.group === true) flat.push(...flattenRows(row.config, at))
  }
  return flat
}

const dialect = loadLoaderDialect()
if (dialect.error !== undefined) {
  err(`[FAIL] 拿不到 loader 的 YAML 方言，无法交叉验证：${dialect.error}`)
  err('  loader 用 js-yaml + entryListSchema（带 !!js 标量类型）；')
  err('  没有它就查不出"转义后被改写"这一整类错误——那正是 v1.1.3 挂掉的原因。')
  process.exit(1)
}

let authoritative
try {
  authoritative = dialect.load(raw, { schema: dialect.schema })
} catch (error) {
  die(`loader 方言解析失败：${error.message}`)
}
if (!Array.isArray(authoritative)) {
  die('loader 方言解析出来的不是顶层列表——补丁文件必须是「一组补丁」的 YAML 数组')
}
notes.push('已用 loader 同款解析器（js-yaml + entryListSchema）交叉验证')

// ── 1d. insert 的形状：若干行 preset 声明 ───────────────────────────────────
//
// 0.2.1 的机制是"孩子的人设与工具面写在一个命名的 agent preset 里"，所以每份补丁插入的
// 是**若干行声明**（审读员 + 主模式），而不是一行。下面先把形状定死，再把每一行的身份
// 钉住——这些字段错了不会报错，只会让模式换个名字、排到别处、或者让 `agentPreset` 指空。

// 形状交给权威解析器判定：读不懂的形状在这里就停下来，后面的检查才有意义。
if (authoritative.length !== patchEntries.length) {
  die(`交叉验证：补丁条目数不一致（本脚本 ${patchEntries.length}，loader 方言 ${authoritative.length}）`)
}
const insertPatches = authoritative.filter((patch) => patch !== null && typeof patch === 'object' && 'insert' in patch)
if (insertPatches.length !== 1) {
  die(`补丁文件顶层应有且只有 1 条 insert 补丁，实际 ${insertPatches.length} 条——`
    + '本包只插自己的声明行，不覆写别人的行（见补丁文件头"这些行可以被用户 patch 覆盖"）')
}
const inserted = insertPatches[0].insert
if (!Array.isArray(inserted)) die('insert 的值不是行列表')

/**
 * 一份补丁应有的声明行数：N 个审读员 + 1 个主模式。
 *
 * 少一行 = 某位读者没有自己的只读工具面（`agentPreset` 会指空、主模式整行 broken）；
 * 多一行 = 有本档位没设计过的角色出现在模式选择器里。两种都不该被静默放行。
 */
const EXPECTED_PRESET_ROWS = PROFILE.reviewers.length + 1
if (inserted.length !== EXPECTED_PRESET_ROWS) {
  die(`insert 应当插入 ${EXPECTED_PRESET_ROWS} 行 preset 声明（${PROFILE.reviewers.length} 个审读员 + 1 个主模式），`
    + `实际 ${inserted.length} 行`)
}
const localInserted = patchEntries.find((patch) => patch !== null && typeof patch === 'object' && 'insert' in patch)?.insert
if (!Array.isArray(localInserted)) die('本脚本的读取器没读出一条 insert 行（补丁形状变了）')
if (localInserted.length !== inserted.length) {
  die(`交叉验证：insert 行数不一致（本脚本 ${localInserted.length}，loader 方言 ${inserted.length}）`)
}

/**
 * 行的 `name` 必须是一个字符串。
 *
 * loader 只对 `config` 求值（`disabled` 单独走 `disabledOf`），**`name` 从不被插值**：
 * `name: !!js …` 会让这个字段变成一个 `{__jsExpr}` 对象，preset registry 的
 * `entryListProblem` 判它 "names no plugin"，整行不挂载——而报错信息离原因很远。
 */
function nameProblem(at, value) {
  return `行 ${at} 的 name 不是字符串（得到 ${JSON.stringify(value)?.slice(0, 80)}）——行的 name 永远不会被插值：`
    + 'loader 只对 config（与 disabled）求值，`name: !!js …` 只会把它变成对象，整行不挂载'
}

/** 把 preset 声明行 `config` 里除 `plugins` 之外的字段取出来（这些才是 loader 会插值的 metadata）。 */
function metadataOf(row) {
  return Object.fromEntries(Object.entries(row?.config ?? {}).filter(([key]) => key !== 'plugins'))
}

/** 两套解析器对同一串 `!!js` 的结果必须逐字相同：不同就说明 YAML 转义把源码改写了。 */
function assertSameExpressions(left, right, where) {
  if (left.length !== right.length) {
    die(`交叉验证：${where} 的 !!js 数量不一致（本脚本 ${left.length}，loader 方言 ${right.length}）`)
  }
  for (let position = 0; position < left.length; position += 1) {
    if (left[position] === right[position]) continue
    err(`[FAIL] ${where} 的第 ${position + 1} 个 !!js 两种解析结果不同——说明值里有 YAML 转义被改写了：`)
    err(`  本脚本（不做转义）：${JSON.stringify(left[position]).slice(0, 160)}`)
    err(`  loader 方言（真实）：${JSON.stringify(right[position]).slice(0, 160)}`)
    process.exit(1)
  }
}

const presetDeclarations = inserted.map((row, index) => {
  const localRow = localInserted[index]
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    die(`insert 里的第 ${index + 1} 行不是映射（preset 声明行必须写成 - id/name/config）`)
  }
  if (localRow === null || typeof localRow !== 'object' || Array.isArray(localRow)) {
    die(`交叉验证：本脚本读到的 insert 第 ${index + 1} 行不是映射`)
  }
  if (typeof row.name !== 'string') die(nameProblem(row.id ?? `insert 第 ${index + 1} 行`, row.name))
  if (localRow.id !== row.id || localRow.name !== row.name) {
    die(`交叉验证：insert 第 ${index + 1} 行的 id/name 两种解析不同（本脚本 ${JSON.stringify(localRow.id)}/${JSON.stringify(localRow.name)}，`
      + `loader 方言 ${JSON.stringify(row.id)}/${JSON.stringify(row.name)}）`)
  }
  const plugins = row.config?.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) {
    die(`preset 行 ${row.id} 的 config.plugins 不是非空行列表——模式（或审读员角色）的全部子插件都写在那里`)
  }
  const localPlugins = localRow.config?.plugins
  if (!Array.isArray(localPlugins) || localPlugins.length !== plugins.length) {
    die(`交叉验证：preset 行 ${row.id} 的 config.plugins 行数不一致（本脚本 ${localPlugins?.length}，loader 方言 ${plugins.length}）`)
  }
  return { index, row, localRow, id: row.id, config: row.config ?? {}, metadata: metadataOf(row), plugins }
})

// 每个声明行（metadata 里若将来出现 `!!js`）与它的子树都要两套解析器逐字比对。
for (const declaration of presetDeclarations) {
  assertSameExpressions(
    jsExprs(metadataOf(declaration.localRow)),
    jsExprs(declaration.metadata),
    `preset 行 ${declaration.id} 的 config（除 plugins 外）`,
  )
  const localChildren = flattenRows(declaration.localRow.config?.plugins ?? [], '')
  const children = flattenRows(declaration.plugins, '')
  if (localChildren.length !== children.length) {
    die(`交叉验证：preset 行 ${declaration.id} 的子插件行数不一致（本脚本 ${localChildren.length}，loader 方言 ${children.length}）`)
  }
  for (let index = 0; index < children.length; index += 1) {
    const mine = localChildren[index]
    const theirs = children[index]
    if (mine.at !== theirs.at) {
      die(`交叉验证：preset 行 ${declaration.id} 第 ${index + 1} 条子行的路径不同（本脚本 ${mine.at}，loader 方言 ${theirs.at}）`)
    }
    if (typeof theirs.row.name !== 'string') die(nameProblem(`${declaration.id}/${theirs.at}`, theirs.row.name))
    if (mine.row.name !== theirs.row.name) {
      die(`子行 ${declaration.id}/${theirs.at} 的 name 两种解析不同（本脚本 ${JSON.stringify(mine.row.name)}，`
        + `loader 方言 ${JSON.stringify(theirs.row.name)}）`)
    }
    if (mine.group !== theirs.group) die(`子行 ${declaration.id}/${theirs.at} 的 group 两种解析不同`)
    // 分组行的 `config` 是**子行列表**：它自己不带 config，子行各自负责自己的表达式。
    if (theirs.group) continue
    assertSameExpressions(jsExprs(mine.row.config ?? {}), jsExprs(theirs.row.config ?? {}), `子行 ${declaration.id}/${theirs.at} 的 config`)
  }
}

/**
 * 全部待检查的条目：先是一条 preset 声明行（`isPreset`），再是它 `config.plugins` 里
 * 摊平后的子行（分组行会递归进 `config`）。路径带上声明行 id，报告里能一眼看出问题在
 * 哪个 preset 里（`preset-short-story-review-b4/persona`）。
 */
const presetEntries = presetDeclarations.map((declaration) => ({
  at: declaration.id,
  path: null,
  row: declaration.row,
  group: false,
  isPreset: true,
  declaration,
  // 声明行要过 `@deepseek-ai/dsh-agent-preset` 的 schema：metadata + **原始**子行列表
  // （子行的 config 由子行各自负责）。`plugins` 是 `z.array(z.any())`，原样传进去。
  schemaConfig: { ...declaration.metadata, plugins: declaration.plugins },
}))
const childEntries = presetDeclarations.flatMap((declaration) => flattenRows(declaration.plugins, '')
  .map((entry) => ({
    at: `${declaration.id}/${entry.at}`,
    path: entry.at,
    row: entry.row,
    group: entry.group,
    isPreset: false,
    declaration,
  })))
const allEntries = [...presetEntries, ...childEntries]

/** 一行自己负责求值 / 编译的 `!!js`（声明行只负责 metadata，`plugins` 交给子行各自负责）。 */
function ownExpressions(entry) {
  const found = []
  if (entry.isPreset === true) jsExprs(entry.declaration.metadata, found)
  else if (entry.group !== true) jsExprs(entry.row.config ?? {}, found)
  if (isJsExpr(entry.row.disabled)) found.push(entry.row.disabled.__jsExpr)
  return found
}

let compiledExpressions = 0
for (const entry of allEntries) {
  for (const source of ownExpressions(entry)) {
    try {
      compileExpression(source)
      compiledExpressions += 1
    } catch (error) {
      err(`[FAIL] ${entry.at} 的 !!js 编译不过：${error.message}`)
      err(`  源码：${JSON.stringify(source).slice(0, 200)}`)
      err('  提示：YAML 双引号标量会先处理 \\n \\t 这类转义；换行请用 String.fromCharCode(10)。')
      process.exit(1)
    }
  }
}

// 只编译还不够：要主动挡住"以后再被写回去"。`!!js` 双引号标量里的反斜杠会被 YAML
// 先吃掉（`\n` → 真换行），而**单引号或折叠标量里的反斜杠是字面量**、不危险。
// 所以只对双引号形式报警，并指明替代写法。
const riskyScalar = [...raw.matchAll(/!!js[ \t]+"([^"\n]*\\[^"\n]*)"/g)]
if (riskyScalar.length > 0) {
  for (const match of riskyScalar) {
    err(`[FAIL] !!js 双引号标量里出现反斜杠转义：${JSON.stringify(match[0]).slice(0, 160)}`)
  }
  err('  YAML 会先处理双引号标量里的 \\n \\t 等转义，JS 源码因此被改写甚至跨行。')
  err('  换行请写 String.fromCharCode(10)；需要字面反斜杠就用单引号或折叠标量（它们不处理转义）。')
  process.exit(1)
}

// ── 1e. 求值环境（临时目录 + junction）与每个 `!!js` 的求值 ──────────────────
//
// `!!js` 在**那一行加载时**求值，那一刻 `ctx.baseUrl` 是 profile 目录（不是包目录），
// 所以包内路径全是 `createRequire(baseUrl).resolve('dsh-story-mode/package.json')` 问出来的。
// 这里就把那个环境搭出来：临时目录 + `<临时目录>/node_modules/dsh-story-mode` 指向仓库根，
// 于是 baseUrl 指过去时 Node 能解析到本包——求值结果与真实挂载一致。
// 不搭这一步的话，所有包内路径都只会 MODULE_NOT_FOUND，而"persona 文件在不在"
// 这类问题就永远查不出来（脚本会变成只会说"通过"的橡皮图章）。
function makeEvaluationEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-story-mode-verify-'))
  const link = join(directory, 'node_modules', 'dsh-story-mode')
  mkdirSync(dirname(link), { recursive: true })
  try {
    // Windows 上 junction 不需要管理员权限或开发者模式；普通目录符号链接需要。
    symlinkSync(ROOT, link, 'junction')
  } catch (junctionError) {
    try {
      symlinkSync(ROOT, link, 'dir')
    } catch {
      die(`建不出求值环境（${link}）：${junctionError.message}——没有它就无法验证包内路径`)
    }
  }
  return {
    directory,
    link,
    // 尾分隔符不能少：少了 Node 会把 profile 目录当成一个**文件**，直接 MODULE_NOT_FOUND。
    baseUrl: pathToFileURL(directory + sep).href,
    dispose() {
      // Windows 上先摘链接再删目录：直接递归删会顺着链接走进仓库。
      try { unlinkSync(link) } catch { /* 已经不在了 */ }
      try { rmSync(directory, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }
    },
  }
}

const environment = makeEvaluationEnvironment()
process.on('exit', () => environment.dispose())
notes.push(`!!js 求值环境：baseUrl=${environment.baseUrl}（临时目录，退出时删除），`
  + 'dsh-story-mode 由其中的 node_modules 链接解析到包根')

/**
 * loader 自己的求值形式：`with (ctx) { return eval(expr) }`。
 *
 * 必须原样照抄——它是**非严格模式**下的直接 eval，所以表达式里的标识符先按 ctx 的属性
 * 解析（`baseUrl` 就是这么来的），`process` 之类的全局照常可见。写成 `return (expr)`
 * 或加上 `"use strict"` 都不是同一个语义（严格模式下 `with` 直接是语法错误）。
 */
const loaderEvaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
const evaluationContext = { baseUrl: environment.baseUrl }
let evaluatedExpressions = 0
function evaluateExpression(source) {
  evaluatedExpressions += 1
  return loaderEvaluate(evaluationContext, source)
}

function interpolate(value) {
  if (isJsExpr(value)) return evaluateExpression(value.__jsExpr)
  if (Array.isArray(value)) return value.map(interpolate)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item)
    return out
  }
  return value
}

// loader 只对 `config` 与 `disabled` 求值（`name` 永远不插值）。这一节把两者都跑一遍，
// 并顺带查"!!js 写在不会被求值的位置上"——那是 `name: !!js …` 那类错误的同一族。
for (const entry of allEntries) {
  const stray = []
  for (const [key, value] of Object.entries(entry.row ?? {})) {
    if (key === 'config' || key === 'disabled') continue
    for (const source of jsExprs(value)) stray.push({ key, source })
  }
  if (stray.length > 0) {
    for (const { key, source } of stray) {
      err(`[FAIL] 行 ${entry.at} 的 ${key} 上有 !!js，但 loader 只对 config 与 disabled 求值：`)
      err(`  ${JSON.stringify(source).slice(0, 160)}`)
    }
    err('  它不会被求值，只会把那个字段变成一个 {__jsExpr} 对象——`name: !!js …` 就是这样让整行报错的。')
    process.exit(1)
  }
  if (entry.isPreset === true) {
    // preset 行的 config 是**载体**（`plugins` 是子行列表），loader 不整体插值它：
    // 子行的表达式由子行自己求值——所以这里只求 metadata，plugins 交给下面每一行。
    try {
      entry.resolvedConfig = interpolate(entry.declaration.metadata)
    } catch (error) {
      fail(`preset 行 ${entry.at} 的 !!js 求值失败：${error.message}`)
      entry.resolvedConfig = {}
    }
  } else if (entry.group) {
    entry.resolvedConfig = {}
  } else {
    try {
      entry.resolvedConfig = interpolate(entry.row.config ?? {})
    } catch (error) {
      fail(`行 ${entry.at} 的 !!js 求值失败：${error.message}`)
      entry.resolvedConfig = {}
    }
  }
  if (isJsExpr(entry.row.disabled)) {
    try {
      entry.disabledValue = Boolean(evaluateExpression(entry.row.disabled.__jsExpr))
    } catch (error) {
      fail(`行 ${entry.at} 的 disabled 表达式求值失败：${error.message}`)
    }
  }
}

const declaredExpressions = allEntries.reduce((sum, entry) => sum + ownExpressions(entry).length, 0)
if (declaredExpressions !== compiledExpressions) {
  die(`!!js 数量对不上：交叉验证阶段编译了 ${compiledExpressions} 个，求值阶段应负责 ${declaredExpressions} 个`
    + '（可能写在分组行自己的 config 里，或者行数两种解析不同）')
}
if (evaluatedExpressions !== declaredExpressions) {
  die(`!!js 求值数量对不上：应当求值 ${declaredExpressions} 个，实际求值 ${evaluatedExpressions} 个——`
    + '说明有表达式被跳过了，脚本不能在这种情况下报"通过"')
}
notes.push(`共 ${compiledExpressions} 个 !!js：全部编译通过、逐字比对未被 YAML 改写，并在临时解析环境里求值`)

// ── 2. 声明行的身份：config.id / order / 名字 / 顺序 ───────────────────────
//
// 这些字段错了不会报错：id 错了 `agentPreset` 指空（主模式 broken）、order 错了在
// 模式选择器里排错位置、名字错了用户看不出该选哪个。审读员行还多一条**顺序**约束：
// `tool-subagent` 在挂载时校验目标声明已经注册——见文件头。
const declarationByPresetId = new Map()
const seenRowIds = new Set()
for (const declaration of presetDeclarations) {
  if (typeof declaration.id !== 'string' || declaration.id.length === 0) {
    fail(`insert 里有一行声明没有 id（loader 靠 id 建表，没有它会静默跳过）`)
    continue
  }
  if (seenRowIds.has(declaration.id)) {
    fail(`loader 行 id 重复：${declaration.id}——loader 按行 id 建表，后者会**静默**覆盖前面的行，一个模式无声消失`)
  }
  seenRowIds.add(declaration.id)
  const presetId = declaration.config.id
  if (typeof presetId !== 'string' || presetId.length === 0) {
    fail(`preset 行 ${declaration.id} 没有 config.id——roster、会话日志与 agentPreset 都按它索引，`
      + `实际 ${JSON.stringify(presetId)}`)
    continue
  }
  if (declarationByPresetId.has(presetId)) {
    fail(`preset config.id 重复：${presetId}（行 ${declarationByPresetId.get(presetId).id} 与 ${declaration.id}）——`
      + '注册表会抛 Duplicate agent preset，两个模式一起 broken')
  } else {
    declarationByPresetId.set(presetId, declaration)
  }
}

const expectedPresetIds = new Set([...PROFILE.reviewers.map((spec) => spec.presetId), PROFILE.main.presetId])
for (const expected of expectedPresetIds) {
  if (!declarationByPresetId.has(expected)) {
    fail(`缺少 config.id 为 ${expected} 的 preset 声明——本档位的${expected === PROFILE.main.presetId ? '主模式' : '一位审读员'}没有声明行`)
  }
}
for (const [presetId, declaration] of declarationByPresetId) {
  if (!expectedPresetIds.has(presetId)) {
    fail(`多出未预期的 preset 声明 ${declaration.id}（config.id ${presetId}）——本档位只声明 `
      + `${[...expectedPresetIds].join('、')}；多出来的行会出现在模式选择器里，也没有工具行指向它`)
  }
}

const mainDeclaration = declarationByPresetId.get(PROFILE.main.presetId)
if (mainDeclaration === undefined) {
  fail(`主模式声明（config.id ${PROFILE.main.presetId}）缺失——这是本档位最重要的一行`)
} else {
  if (mainDeclaration.id !== PROFILE.main.rowId) {
    fail(`主模式的 loader 行 id 应为 ${PROFILE.main.rowId}（profile 的补丁按它覆写），实际 ${JSON.stringify(mainDeclaration.id)}`)
  }
  if (mainDeclaration.config.order !== PROFILE.main.order) {
    fail(`主模式 config.order 应为 ${PROFILE.main.order}（官方预设占 1–4；完整版 5、精简版排在它后面），`
      + `实际 ${JSON.stringify(mainDeclaration.config.order)}`)
  }
  const name = mainDeclaration.config.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail(`主模式 config.name 是非空字符串（roster 里显示的名字），实际 ${JSON.stringify(name)}`)
  } else if (PROFILE.main.nameHint !== null && !name.includes(PROFILE.main.nameHint)) {
    fail(`主模式 config.name 应自报档位（包含「${PROFILE.main.nameHint}」），实际 ${JSON.stringify(name)}`)
  }
  if (typeof mainDeclaration.config.description !== 'string' || mainDeclaration.config.description.trim().length === 0) {
    fail('主模式 config.description 是非空字符串（模式选择器里的说明）')
  }
  if (mainDeclaration.disabledValue === true) {
    fail(`主模式声明 ${mainDeclaration.id} 被 disabled——整个模式不会挂载`)
  }
}

for (const spec of PROFILE.reviewers) {
  const declaration = declarationByPresetId.get(spec.presetId)
  if (declaration === undefined) continue // 缺声明上面已经报过
  if (declaration.id !== spec.rowId) {
    fail(`审读员 ${spec.presetId} 的 loader 行 id 应为 ${spec.rowId}，实际 ${JSON.stringify(declaration.id)}`)
  }
  if (declaration.config.order !== spec.order) {
    fail(`审读员 ${spec.presetId} 的 config.order 应为 ${spec.order}，实际 ${JSON.stringify(declaration.config.order)}`
      + '（101+ 排在主模式之后；它们会出现在模式选择器里，order 与名字一起告诉用户不要直接选）')
  }
  const name = declaration.config.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail(`审读员 ${spec.presetId} 的 config.name 是非空字符串，实际 ${JSON.stringify(name)}`)
  } else {
    if (!name.includes(spec.nameHint)) {
      fail(`审读员 ${spec.presetId} 的 config.name 应标明角色（包含「${spec.nameHint}」），实际 ${JSON.stringify(name)}`)
    }
    if (!name.includes('内部')) {
      fail(`审读员 ${spec.presetId} 的 config.name 必须带「内部」——0.2.1 的 preset 注册表没有隐藏字段，`
        + '这些行会出现在模式选择器里，名字要让人一眼看出不该直接选')
    }
  }
  const description = declaration.config.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    fail(`审读员 ${spec.presetId} 的 config.description 是非空字符串（选择器里要说明它是派发用的）`)
  } else if (!description.includes('不要直接选择')) {
    fail(`审读员 ${spec.presetId} 的 config.description 必须写明"不要直接选择"——`
      + '这些 preset 没有隐藏字段，会出现在模式选择器里，选错只会得到一个只读阅读器')
  }
  if (declaration.disabledValue === true) {
    fail(`审读员声明 ${declaration.id} 被 disabled——主模式的 agentPreset 会指空，整行在挂载时 broken`)
  }
  if (declaration.plugins.some((row) => row.group === true)) {
    fail(`审读员 preset ${spec.presetId} 里出现了分组行——只读组合只有三行平铺的子插件，不需要 realm 分组`)
  }
}

// 顺序：审读员行按角色表的顺序排在主模式行**之前**。倒序是 0.2.1 最典型的一次
// "文件形状完全合法、装上去整个模式 broken"的故障，所以顺序被当成硬契约。
if (mainDeclaration !== undefined) {
  let previous = null
  for (const spec of PROFILE.reviewers) {
    const declaration = declarationByPresetId.get(spec.presetId)
    if (declaration === undefined) continue
    if (declaration.index > mainDeclaration.index) {
      fail(`审读员 preset 行 ${declaration.id}（config.id ${spec.presetId}）排在主模式行 ${mainDeclaration.id} **之后**`
        + '——0.2.1 的 tool-subagent 在挂载时就校验 agentPreset 指向的声明已经注册；'
        + '倒序会让整个主模式变成 broken 行（模式在选择器里红着、切不进去）')
    }
    if (previous !== null && declaration.index <= previous.index) {
      fail(`审读员 preset 行的顺序不对：${declaration.id} 应排在 ${previous.id} 之后——`
        + `顺序固定为 ${PROFILE.reviewers.map((item) => item.rowId).join(' → ')}，最后才是主模式`)
    }
    previous = declaration
  }
}

notes.push(`preset 声明 ${presetDeclarations.length} 行：${presetDeclarations.map((declaration) => declaration.id).join('、')}`)

// 主模式的子插件（后面所有检查都在这个集合里找行）。
const mainChildren = mainDeclaration === undefined
  ? []
  : childEntries.filter((entry) => entry.declaration === mainDeclaration)
const mainChild = (path) => mainChildren.find((entry) => entry.path === path)

// ── 3. 每一行的 config 过插件自己的 schema ──────────────────────────────────
//
// 组合里写的字段名/类型与插件自己的 `Config` 不符时，loader 会在挂载那一刻拒绝整行；
// 表现同样是 preset broken。这里用 harness 里那个插件的真实 schema 逐行校验——**审读员
// 声明行与工具行都在内**：前者错 `plugins` 缺失/类型不对，后者错 `agentPreset` 类型或
// 拼写字段（schema 会忽略未知字段，所以"0.1.7 遗留字段"另有一节专门查）。
const packageEntry = (pkg) => {
  const root = pkg.exports?.['.']
  if (typeof root === 'string') return root
  if (root !== null && typeof root === 'object') {
    for (const key of ['default', 'import', 'require', 'node']) {
      if (typeof root[key] === 'string') return root[key]
    }
  }
  return typeof pkg.main === 'string' ? pkg.main : './lib/index.js'
}

let schemaChecked = 0
for (const entry of allEntries) {
  if (entry.group) continue
  const name = entry.row.name
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/dsh-')) continue
  const basePackage = name.split('/').slice(0, 2).join('/')
  let baseEntryPath
  try {
    baseEntryPath = harnessRequire.resolve(`${basePackage}/package.json`)
  } catch {
    // 包名敲错时 loader 不会在自检时告诉你：它只会在挂载时把整行标成 broken。所以这里失败。
    fail(`行 ${entry.at} 的插件包 ${basePackage} 解析不到——行名敲错会让整行在挂载时 broken`)
    continue
  }
  // 子路径入口（`…/list-agents`）的 package.json 通常不在 exports 里；schema 校验
  // 只对整包行做，它们才是带 config 的那些。
  if (name !== basePackage) continue
  try {
    const pkg = JSON.parse(await readFile(baseEntryPath, 'utf8'))
    const moduleUrl = new URL(packageEntry(pkg), pathToFileURL(baseEntryPath))
    const mod = await import(moduleUrl.href)
    // 两种导出形态：命名导出 `Config`，或默认导出的插件类上的 `static Config`。
    // 漏掉后者会让 agent-preset / tool-result-pruner 这类行**静默跳过**校验。
    const schema = typeof mod.Config === 'function' ? mod.Config : mod.default?.Config
    if (typeof schema === 'function') {
      try {
        schema(entry.schemaConfig ?? entry.resolvedConfig ?? {})
        schemaChecked += 1
      } catch (error) {
        fail(`行 ${entry.at}（${name}）config 过不了插件自己的 schema：${error.message}`)
      }
    } else {
      notes.push(`行 ${entry.at}（${name}）没有导出 Config，跳过 schema 校验`)
    }
  } catch (error) {
    fail(`行 ${entry.at}（${name}）导入失败，无法校验：${error.message}`)
  }
}
// preset 声明行的 schemaConfig 在构造条目时就算好了（metadata + **原始**子行列表：子行的
// config 由子行各自负责），所以上面这一圈已经把声明行一起校验过了。
notes.push(`config 过 schema：${schemaChecked} 行（用的是 harness 里那些插件自己的 Config）`)

// ── 4. 技能根与审读员人设文件 ───────────────────────────────────────────────
//
// 这两件事都是"路径只有运行时才算得出来"的：skill-filesystem 的 customSkillDirs 与每个
// 审读员 persona 都由 `!!js` 在挂载时求值。第 1d 节已经让它们真的跑过一遍，这里只判断
// 结果对不对——文件缺失会让那一行 config 无效、整个 preset 挂不上。
// 期望值全部来自 PROFILES：完整版一个技能根（两份技能）、精简版两个根（各自一份），
// 人名与 persona 片段也一样是"按档位取值"，检查代码一条都不分档。

// 技能文件在报告里的称呼：根下相对路径就够用；根**自己**就是技能目录（文件写 `SKILL.md`）时
// 补上根目录名——否则两个根各自那份 `SKILL.md` 在报告里同名，分不清是谁。
const skillLabel = (rootDir, file) => (file.includes('/') ? file : `${basename(rootDir)}/${file}`)

const skillRow = mainChild('skill-filesystem')
const skillDirs = skillRow?.resolvedConfig?.customSkillDirs
if (skillRow === undefined) {
  fail(`主模式里没有 id: skill-filesystem 的那一行——技能（含文风契约）不会挂进本模式`)
} else if (!Array.isArray(skillDirs) || skillDirs.length === 0) {
  fail(`行 ${skillRow.at} 的 customSkillDirs 不是非空列表：${JSON.stringify(skillDirs)}`)
} else {
  const samePath = (left, right) => {
    const canonical = (value) => { try { return realpathSync(value) } catch { return resolve(value) } }
    const a = canonical(left)
    const b = canonical(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  // 每个根都必须落在**包内**：技能是跟着包走的，指到包外（或写死本机绝对路径）时，装到别的
  // 机器上会指向一个不存在的目录，而技能清单只是静默为空——模型第一次 `skill` 调用才发现。
  const insidePackage = (value) => {
    if (typeof value !== 'string' || value.length === 0) return false
    const rel = relative(ROOT, value)
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }
  for (const dir of skillDirs) {
    if (!insidePackage(dir)) {
      fail(`行 ${skillRow.at} 的 customSkillDirs 项没落在包内：${JSON.stringify(dir)}——`
        + '技能必须跟着包走；包外路径在别的机器上不存在，模式里只会得到"技能不可用"')
    }
  }
  if (skillDirs.length !== PROFILE.main.skillRoots.length) {
    fail(`行 ${skillRow.at} 的 customSkillDirs 应有 ${PROFILE.main.skillRoots.length} 个根`
      + `（${PROFILE.main.skillRoots.map((root) => root.label).join('、')}），`
      + `实际 ${skillDirs.length} 个：${JSON.stringify(skillDirs)}`)
  }
  for (let index = 0; index < PROFILE.main.skillRoots.length; index += 1) {
    const root = PROFILE.main.skillRoots[index]
    const expected = join(ROOT, root.dir)
    if (index < skillDirs.length && !samePath(skillDirs[index], expected)) {
      // 位置也算数：精简版第二个根指向契约**目录本身**（扫描根时目录取 `<目录>/SKILL.md`），
      // 指回 `skills/` 会把完整版的 `short-story` 技能一起挂进精简会话，而那份技能里的派发
      // 规则对应的是本模式没有的五个角色工具。
      fail(`行 ${skillRow.at} 的 customSkillDirs[${index}] 没指到${root.label}：${skillDirs[index]}（应为 ${expected}）`)
      continue
    }
    if (index >= skillDirs.length) continue // 缺项上面已经报过，这里不再重复刷屏
    for (const skill of root.skills) {
      const file = join(expected, skill)
      const label = skillLabel(root.dir, skill)
      try {
        const text = await readFile(file, 'utf8')
        if (text.trim().length === 0) fail(`技能 ${label} 是空的：${file}`)
        else notes.push(`技能 ${label}：${text.length} 字符（由 customSkillDirs 指向）`)
      } catch (error) {
        fail(`技能 ${label} 读不到：${error.message}`)
      }
    }
  }
}

// ── 4b. 审读员 preset：只读是**组合**保证的 ────────────────────────────────
//
// 0.2.1 没有 `toolFilter`：审读员的工具面 = 那个 preset 里挂了的行。所以只读不是名单问题，
// 而是"这个 preset 里到底有什么"的问题。下面把三行钉死，任何一行多出来（编辑器、写文件、
// 交付、技能、压缩）都会失败——这正是旧机制里 allow/deny 对账要防的那类回归，现在更硬。
const READER_ROWS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
]
const readerRowNote = '（只读是组合保证的：写入、编辑、交付、委派、技能与压缩工具根本没有挂载）'

/** 人设必须**逐字**等于档位表里那几份文件按顺序拼起来的结果（多片段用换行连接）。 */
async function checkReviewerPersona(spec, declaration, entry) {
  const persona = entry.resolvedConfig?.prefix
  const parts = []
  for (const part of spec.persona) {
    try {
      const text = await readFile(part.file, 'utf8')
      if (text.trim().length === 0) {
        fail(`审读员 ${spec.presetId} 的人设文件是空的：${part.file}`)
        return
      }
      parts.push({ part, text })
    } catch (error) {
      fail(`审读员 ${spec.presetId} 的人设文件读不到：${part.file}：${error.message}`)
      return
    }
  }
  if (typeof persona !== 'string' || persona.length === 0) {
    fail(`审读员 ${spec.presetId} 的 persona 没读出来（得到 ${JSON.stringify(persona)?.slice(0, 40)}）——`
      + '人设必须由那一行的 !!js 在挂载时从包内文件读出')
    return
  }
  const expected = parts.map(({ text }) => text).join(String.fromCharCode(10))
  if (persona !== expected) {
    const reversed = [...parts].reverse().map(({ text }) => text).join(String.fromCharCode(10))
    if (parts.length > 1 && persona === reversed) {
      fail(`审读员 ${spec.presetId} 的 persona 把顺序拼反了：必须是**`
        + `${parts.map(({ part }) => part.label).join('在前、')}在后**`
        + '——契约的使用说明要求"先读作者要求、再完整读正文、最后对照契约"，而 persona 在 system prompt 最前')
    } else if (parts.length === 1) {
      fail(`审读员 ${spec.presetId} 的 persona 与 ${parts[0].part.label} 的内容不一致`
        + `（persona ${persona.length} 字符，文件 ${expected.length} 字符）——人设必须逐字来自它自己那份文件`)
    } else {
      fail(`审读员 ${spec.presetId} 的 persona ≠ ${parts.map(({ part }) => part.label).join(' + 换行 + ')}`
        + `（persona ${persona.length} 字符，应为 ${expected.length} 字符）`)
    }
    return
  }
  // 单片段时沿用既有的短报告（`= b1-cold-read.md`）；多片段时把每段的长度都列出来——那样
  // "少拼了契约"在绿色输出里也看得见（少一段，行里就少一个 `+ 换行 +`）。拼法与旧版逐字相同。
  notes.push(parts.length === 1
    ? `  ${spec.toolName}: persona ${persona.length} 字符 = ${parts[0].part.label}`
    : `  ${spec.toolName}: persona ${persona.length} 字符 = `
      + parts.map(({ part, text }) => `${part.label}（${text.length}）`).join('+ 换行 + '))
}

for (const spec of PROFILE.reviewers) {
  const declaration = declarationByPresetId.get(spec.presetId)
  if (declaration === undefined) continue // 缺声明上面已经报过
  const children = childEntries.filter((entry) => entry.declaration === declaration)
  if (children.length !== READER_ROWS.length) {
    fail(`审读员 preset ${spec.presetId} 的子行应为 ${READER_ROWS.length} 行`
      + `（${READER_ROWS.map((row) => row.id).join('、')}），实际 ${children.length} 行：`
      + `${children.map((entry) => entry.path).join('、') || '（无）'}${readerRowNote}`)
  }
  for (const expected of READER_ROWS) {
    const child = children.find((entry) => entry.path === expected.id)
    if (child === undefined) {
      fail(`审读员 preset ${spec.presetId} 里缺少 ${expected.id} 行（${expected.name}）${readerRowNote}`)
      continue
    }
    if (child.row.name !== expected.name) {
      fail(`审读员 preset ${spec.presetId} 的 ${expected.id} 行 name 应为 ${expected.name}，`
        + `实际 ${JSON.stringify(child.row.name)}`)
    }
    if (child.group === true) {
      fail(`审读员 preset ${spec.presetId} 的 ${expected.id} 行是分组行——只读组合是三行平铺子插件`)
    }
    if (child.disabledValue === true) {
      fail(`审读员 preset ${spec.presetId} 的 ${expected.id} 行被 disabled——它在挂载时静默消失，只读组合就名存实亡`)
    }
  }
  for (const child of children) {
    if (!READER_ROWS.some((row) => row.id === child.path)) {
      fail(`审读员 preset ${spec.presetId} 多出子行 ${child.path}（${child.row.name}）${readerRowNote}`)
    }
  }

  const personaRow = children.find((entry) => entry.path === 'persona')
  if (personaRow !== undefined) await checkReviewerPersona(spec, declaration, personaRow)

  const fsRow = children.find((entry) => entry.path === 'tool-fs')
  if (fsRow !== undefined) {
    const config = fsRow.resolvedConfig ?? {}
    // 四项必须**逐个写出**：不写就吃到默认值（read/readImage/write/edit 全开）——
    // 那是"审读员拿到写/编辑工具"最隐蔽的一条路径，文件里看不出任何多余行。
    for (const [key, value] of Object.entries({ read: true, readImage: true, write: false, edit: false })) {
      if (config[key] !== value) {
        fail(`审读员 preset ${spec.presetId} 的 tool-fs.${key} 应为 ${String(value)}，`
          + `实际 ${JSON.stringify(config[key])}——四个开关必须逐个写明确：不写就默认全开，审读员会拿到写与编辑工具`)
      }
    }
  }

  const searchRow = children.find((entry) => entry.path === 'tool-fs-search')
  if (searchRow !== undefined) {
    const value = (searchRow.resolvedConfig ?? {}).sampleOverCapGlobResults
    if (value !== false) {
      fail(`审读员 preset ${spec.presetId} 的 tool-fs-search.sampleOverCapGlobResults 应为 false`
        + `（schema 必填项），实际 ${JSON.stringify(value)}`)
    }
  }
}

// ── 5. 审读员工具行：provider / toolName / agentPreset，且没有 0.1.7 遗留字段 ──
//
// 0.2.1 的 `tool-subagent` 每行 = 一个 backend + 一个工具名；孩子的人设与工具面来自
// `agentPreset`。这一节钉住三件事，每一件错了都不在装配时报错、只在派发时静默变形：
//   * `provider` 必须是 spawn（fork 继承上下文，读者看过底牌）；
//   * 审读员行必须有 `agentPreset` 且指到本档位声明的审读员 id（漏写 = 继承主模式的全部工具）；
//   * 不许带 persona/toolFilter/backgroundMode——前两项 0.2.1 硬报错，第三项会被静默忽略。
const TOOL_SUBAGENT_PACKAGE = '@deepseek-ai/dsh-tool-subagent'
// 0.2.1 `dsh-tool-subagent` 的 Config 字段。白名单是刻意的：未知字段 schema 会忽略，
// 而"0.1.7 遗留字段"正是这样进入文件、在运行时表现成挂载失败或语义悄悄变化。
const TOOL_SUBAGENT_KEYS = new Set([
  'provider', 'toolName', 'modelSelectionSettings', 'agentOptions', 'agentPreset', 'allowedAgentPresets', 'maxDepth',
])
const LEGACY_TOOL_FIELDS = new Set(['persona', 'toolFilter', 'backgroundMode'])
const toolRows = mainChildren.filter((entry) => entry.row.name === TOOL_SUBAGENT_PACKAGE)
const reviewerToolRows = new Map()
const genericToolRows = []

for (const entry of toolRows) {
  const config = entry.resolvedConfig ?? {}
  if (entry.disabledValue === true) {
    fail(`工具行 ${entry.at} 被 disabled——它会静默消失，模型侧少一件工具而没有报错`)
  }
  for (const key of Object.keys(config)) {
    if (TOOL_SUBAGENT_KEYS.has(key)) continue
    if (LEGACY_TOOL_FIELDS.has(key)) {
      fail(`工具行 ${entry.at}（${JSON.stringify(config.toolName)}）带 0.1.7 遗留字段 ${key}——`
        + '0.2.1 里 persona/toolFilter 是**硬报错**（挂载即失败、整个模式 broken），'
        + 'backgroundMode 会被静默忽略（每次派发都是后台受管 activation，没有前台/可续接开关）')
    } else {
      fail(`工具行 ${entry.at} 的 config 里有本脚本不认识的字段 ${key}——`
        + `tool-subagent 的 Config 只有 ${[...TOOL_SUBAGENT_KEYS].join('、')}；多出来的字段不报错也不生效`)
    }
  }
  if (config.provider === 'fork') {
    fail(`工具行 ${entry.at} 用了 provider: fork——fork 继承主代理的全部上下文，读者看过底牌就不再是读者证据`)
  } else if (config.provider !== 'spawn') {
    fail(`工具行 ${entry.at} 的 provider 是 ${JSON.stringify(config.provider)}，应为 spawn`
      + '（0.2.1 每次派发都是独立上下文的后台 activation）')
  }
  const toolName = config.toolName
  if (toolName === PROFILE.main.genericToolName) {
    genericToolRows.push(entry)
    continue
  }
  if (PROFILE.reviewers.some((spec) => spec.toolName === toolName)) {
    reviewerToolRows.set(toolName, entry)
    continue
  }
  // 名字敲错（`subagent_reviei_b1`）会静默少一位读者，而且它不会被算进"审读员行"，
  // 只按档位点名筛的话这一行会直接消失——所以这里按"不属于任何一类"报错。
  fail(`工具行 ${entry.at} 的 toolName 是 ${JSON.stringify(toolName)}——本档位的 tool-subagent 行`
    + `只有通用 ${PROFILE.main.genericToolName} 与审读员 ${PROFILE.reviewerToolNameHint}`)
}

if (genericToolRows.length !== 1) {
  fail(`通用出口（toolName: ${PROFILE.main.genericToolName}）应有且只有 1 行，实际 ${genericToolRows.length} 行`
    + '——它不写 agentPreset，孩子加入父代理当前的 preset 修订，是"再找一双眼睛"的唯一出口')
}
for (const entry of genericToolRows) {
  if (entry.resolvedConfig?.agentPreset !== undefined) {
    fail(`通用出口 ${entry.at} 写了 agentPreset: ${JSON.stringify(entry.resolvedConfig.agentPreset)}——`
      + '它有意不写：孩子继承父代理当前的 preset（带着整套写作工具），才适合查资料、核对设定；'
      + '钉到一个审读员 preset 会把它静默变成第六个只读读者')
  }
}

for (const spec of PROFILE.reviewers) {
  const entry = reviewerToolRows.get(spec.toolName)
  if (entry === undefined) {
    fail(`缺少审读员工具行 toolName: ${spec.toolName}——本档位角色表点了名，而它没有自己的工具`
      + `（应写 provider: spawn、toolName: ${spec.toolName}、agentPreset: ${spec.presetId}）`)
    continue
  }
  const config = entry.resolvedConfig ?? {}
  if (config.agentPreset === undefined) {
    fail(`审读员工具行 ${entry.at}（${spec.toolName}）没有 agentPreset——0.2.1 删掉了 persona/toolFilter，`
      + '孩子的人设与只读工具面**只能**来自 agentPreset 指向的声明；不写就是继承主模式，'
      + '审读员会拿到写文件、精确编辑器、技能与再委派工具')
    continue
  }
  if (config.agentPreset !== spec.presetId) {
    fail(`审读员工具行 ${entry.at}（${spec.toolName}）的 agentPreset 是 ${JSON.stringify(config.agentPreset)}，`
      + `应指向 ${spec.presetId}`)
  }
}
// 每个 agentPreset 都必须指到本档位声明的审读员：指到不存在的 id 会让整行在挂载时 broken；
// 指到主模式自己会成环（孩子又拿到主模式）。已声明的审读员由上面的存在性检查保证。
for (const entry of toolRows) {
  const presetId = entry.resolvedConfig?.agentPreset
  if (typeof presetId !== 'string') continue
  if (!PROFILE.reviewers.some((spec) => spec.presetId === presetId)) {
    fail(`工具行 ${entry.at} 的 agentPreset ${JSON.stringify(presetId)} 不是本档位声明的审读员 preset`
      + `（应为 ${PROFILE.reviewers.map((spec) => spec.presetId).join('、')}）`)
  }
}

// 整份补丁的 YAML 里不得出现 `toolFilter:` / `backgroundMode:`。查的是**去掉注释后的
// 配置行**：文件头用大量注释解释"为什么删掉这两项"，那是说明不是配置。行首（缩进后）
// 出现就是 0.1.7 的写法漏回来了——persona/toolFilter 会让挂载直接抛错。
for (const field of ['toolFilter', 'backgroundMode']) {
  const pattern = new RegExp(`^\\s*(?:-\\s*)?${field}\\s*:`)
  raw.split(/\r?\n/).forEach((line, index) => {
    const code = stripComment(line)
    if (pattern.test(code)) {
      fail(`第 ${index + 1} 行的配置里出现了 0.1.7 遗留字段 ${field}：${code.trim()}——`
        + '0.2.1 没有这个配置项（persona/toolFilter 是硬报错，backgroundMode 会被静默忽略），'
        + '整份补丁里一个都不该有')
    }
  })
}

// 精简版**刻意不要**的角色工具名：只扫**解析后的 toolName**，不扫原文——补丁注释里正
// 解释着"本模式没有 subagent_review_b* 工具"（见档位表）。
if (PROFILE.forbiddenReviewerPattern !== null) {
  for (const entry of childEntries) {
    const name = entry.resolvedConfig?.toolName
    if (typeof name === 'string' && PROFILE.forbiddenReviewerPattern.test(name)) {
      fail(`行 ${entry.at} 的工具名 ${JSON.stringify(name)} 是本档位刻意不要的——精简版只有一位合并审读员`
        + `（${PROFILE.reviewers.map((spec) => spec.toolName).join('、')}），五个角色化工具不存在`)
    }
  }
}

// 工具名不能重复：两行抢同一个名字＝后挂载的那一行被静默替换（模型侧只看到一件工具）。
const seenToolNames = new Map()
for (const entry of allEntries) {
  const name = entry.resolvedConfig?.toolName
  if (typeof name !== 'string') continue
  if (seenToolNames.has(name)) {
    fail(`工具名重复：${name}（${seenToolNames.get(name)} 与 ${entry.at}）——两行会抢同一个名字，后挂载的静默覆盖前者`)
  } else {
    seenToolNames.set(name, entry.at)
  }
}

notes.push(`审读员工具行 ${PROFILE.reviewers.length} 行：provider=spawn、toolName 各自独立、agentPreset 指向已声明的审读员 preset；`
  + `通用出口 ${PROFILE.main.genericToolName} 不写 agentPreset`)

// ── 6. 必须有的行与刻意不要的行 ─────────────────────────────────────────────
//
// 缺一行不一定报错，只会静默少一项能力：没有 control 行就没有 send_message / list_agents，
// 复核与"找回 childId"就断了。精简版刻意砍掉的行则要**双向**钉住：只查"缺了什么"的话，
// 顺手把整行加回来不会被拦——那会把每轮前缀重新撑大，而功能上没人会发现多了什么。
for (const required of PROFILE.main.requiredRowNames) {
  if (!mainChildren.some((entry) => entry.row.name === required)) {
    fail(`主模式里没有 ${required} 那一行——send_message / list_agents 少一个，审读员就复用不起来`)
  }
}
for (const forbidden of PROFILE.main.forbiddenRowNames) {
  if (mainChildren.some((entry) => entry.row.name === forbidden || entry.row.name.startsWith(`${forbidden}/`))) {
    fail(`主模式里出现了本档位刻意不要的 ${forbidden} 那一行——精简版砍掉它是设计意图（见补丁文件头），不是漏了`)
  }
}

// ── 7. 静态形状与可移植性 ───────────────────────────────────────────────────
//
// 这一节查的都是"改错了要到别的机器上才发作"的东西：行的 name 永不被插值、包内路径
// 不能写死成本机绝对路径、插进去的行只能是 loader 认得的 key。
//
// 关键约束（都是从 loader 源码里读出来的，见补丁文件头）：
//   * **行的 `name` 永远不会被插值**，loader 只对 `config` 调 `interpolate()`
//     （`disabled` 单独走 `disabledOf`）。所以子行的 `name: !!js …` 会变成对象、整行报错。
//   * 子行的解析基准是 **profile 目录**，不是包目录。本包自己的插件行只能写裸包名
//     `dsh-story-mode`（profile 的 node_modules 里就是它）；相对路径与 file:// 都会钉死安装位置。
// 补丁只允许 `insert`：loader 认得的补丁 key 还有 id/name/config/group/disabled/inject/
// isolate，但**本包一个都不该用**——覆写别人的行就是和官方抢同一行，官方加字段就会被静默
// 抹掉（这正是 0.1.7 之前那版补丁的代价，见补丁文件头）。真要放开，先在这里写下理由。
const ALLOWED_PATCH_KEYS = new Set(['insert'])
// 行 key 就是 loader 的 `EntryOptions`（isolate 是它模块增强出来的那一个，本组合的分组行在用）。
const ALLOWED_ROW_KEYS = new Set(['id', 'name', 'config', 'group', 'disabled', 'inject', 'isolate'])

for (const patch of authoritative) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    fail(`补丁条目不是映射：${JSON.stringify(patch)?.slice(0, 60)}`)
    continue
  }
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      fail(`补丁条目里有不认识的 key "${key}"——本包只插自己的声明行；覆写别人的行会和官方抢行`
        + '（官方加字段就被静默抹掉），真要那么做先在这里把理由写清楚')
    }
  }
}
for (const entry of allEntries) {
  for (const key of Object.keys(entry.row ?? {})) {
    if (!ALLOWED_ROW_KEYS.has(key)) {
      fail(`行 ${entry.at} 里有 loader 不认得的 key "${key}"——loader 会原样收下它（不报错也不生效），`
        + '所以在这里拦住')
    }
  }
  if (typeof entry.row?.name !== 'string') {
    fail(`行 ${entry.at} 的 name 不是字符串（${JSON.stringify(entry.row?.name)?.slice(0, 60)}）——行的 name 从不被插值`)
  } else if (entry.row.name.startsWith('.') || entry.row.name.startsWith('/') || entry.row.name.includes(':')) {
    // `cordis:group` 这类内置名字除外（它由 loader 的 builtins 提供）。
    if (!entry.row.name.startsWith('cordis:')) {
      fail(`行 ${entry.at} 的 name "${entry.row.name}" 是相对/绝对路径或 URL——`
        + 'config.plugins 里的名字按 profile 目录解析，只有裸包名才稳（见补丁文件头第 2 条）')
    }
  }
}
// `name: !!js …` 在权威解析后已经不是字符串（上面那条会报），这里再按原文拦一次：
// 它会先把值变成对象，报错信息离原因很远。
if (/^[ \t]*name:[ \t]*!!js/m.test(raw)) {
  die('行的 name 上写了 !!js——loader 只对 config 与 disabled 求值，name 从不被插值')
}

const ownRow = mainChild('story-tools')
if (ownRow === undefined) {
  fail('主模式里没有 id: story-tools 的那一行——本包自己的插件（story_wordcount / story_lint 等）没被插进去')
} else if (ownRow.row.name !== 'dsh-story-mode') {
  fail(`id: story-tools 的 name 必须是**裸包名** dsh-story-mode（profile 的 node_modules 里就是它），`
    + `实际 ${JSON.stringify(ownRow.row.name)}`)
}

if (/[A-Za-z]:\\/.test(raw)) {
  fail('补丁里出现了机器相关的 Windows 绝对路径（[A-Za-z]:\\）——包内路径只能在运行时用 createRequire(baseUrl) 问出来')
}
if (/file:\/\//.test(raw)) {
  fail('补丁里出现了 file:// URL——安装位置在发布时不可能知道，写死会让这个补丁在别的机器上指向不存在的文件')
}

const ownEntry = join(ROOT, 'lib', 'index.js')
if (!existsSync(ownEntry)) {
  fail(`lib/index.js 不存在（${ownEntry}）——story-tools 那一行会加载失败`)
} else {
  try {
    const module = await import(pathToFileURL(ownEntry).href)
    if (typeof module.apply !== 'function') fail('lib/index.js 没有导出 apply——loader 会把它当成无效插件')
  } catch (error) {
    fail(`lib/index.js 导入失败：${error.message}`)
  }
}

// 入口技能里的两条新契约（只查最便宜、最容易在改稿时被删掉的两句）：每次派发立即返回
// childId，改稿复核用 send_message 发回同一位读者。删掉它们，可复用就只是配置。
// 查的是**本档位的入口技能**：精简版的流程规则住在 `skills-lite/short-story-lite/SKILL.md`，
// 完整版那份 `skills/short-story/SKILL.md` 在精简会话里根本不挂（见补丁文件头第五条）。
const entrySkill = join(ROOT, PROFILE.main.entrySkill)
try {
  const text = await readFile(entrySkill, 'utf8')
  if (!text.includes('send_message')) {
    fail(`${PROFILE.main.entrySkill} 没提 send_message——改稿复核要靠它发回同一位读者`)
  }
  if (!text.includes('childId')) {
    fail(`${PROFILE.main.entrySkill} 没有提 childId——0.2.1 每次派发都立即返回 childId，`
      + '复核要靠它发回同一位读者；不写它，模型会以为派发是前台等待、或者复核时另起一位冷读者')
  }
} catch (error) {
  fail(`${PROFILE.main.entrySkill} 读不到：${error.message}`)
}
notes.push('静态形状：行名全是包标识符、包内路径无绝对路径与 file://、patch/行 key 在 loader 认得的集合里、'
  + '入口技能写明了 childId + send_message')

// ── 输出 ────────────────────────────────────────────────────────────────────

out('# 组合自检')
out('')
for (const note of notes) out(`- ${note}`)
out('')
if (failures.length === 0) {
  out('全部通过：补丁形状正确（声明行数、审读员行排在主模式之前）、每个 !!js 可编译且未被 YAML 转义改写、'
    + '每行 config 过插件自己的 schema、审读员 preset 只挂只读组合（persona + tool-fs read/readImage + tool-fs-search）、'
    + '工具行 provider/spawn 且 agentPreset 指得到、补丁里没有任何 0.1.7 遗留字段。')
  process.exit(0)
}
err(`有 ${failures.length} 项失败：`)
for (const failure of failures) err(`  - ${failure}`)
process.exit(1)
