import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctorTool, renderDoctor } from '../lib/doctor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

/**
 * 组合现在住在 bundle patch 里：`cordis.patch.yml` 插入一行 preset 声明，
 * 子插件列表就是那一行的 `config.plugins`。技能住在包根的 `skills/`。
 */
const COMPOSITION = 'cordis.patch.yml'
const SKILLS = 'skills'
const SKILL = 'skills/short-story/SKILL.md'
const PANEL = 'skills/short-story/references/review-panel.md'
const WORKFLOW = 'skills/short-story/references/writing-workflow.md'
const REVIEWER_DIR = 'skills/short-story/references/reviewers'
/** 角色、工具名、人设文件、B3/B4 触发条件里必须出现的可观测判据。 */
const ROLES = [
  { role: 'b1', file: 'b1-cold-read.md', tool: 'subagent_review_b1' },
  { role: 'b2', file: 'b2-story-logic.md', tool: 'subagent_review_b2' },
  { role: 'b3', file: 'b3-reading-experience.md', tool: 'subagent_review_b3' },
  { role: 'b4', file: 'b4-style-execution.md', tool: 'subagent_review_b4' },
  { role: 'b5', file: 'b5-physical-continuity.md', tool: 'subagent_review_b5' },
]

test('the patch inserts its own preset declaration row instead of touching an official row', async () => {
  const patch = await read(COMPOSITION)
  // 0.1.7 起 `agent-presets` 这一行不存在了：注册表不扫描目录，preset 是普通行。
  assert.doesNotMatch(patch, /^-\s*id:\s*agent-presets\s*$/m, '旧版 roster 行已随 0.1.7 消失')
  assert.match(patch, /^-\s*insert:\s*$/m, '必须是 insert 层：不覆盖别人的行')
  assert.match(patch, /^ {4}- id: preset-short-story$/m)
  assert.match(patch, /^ {6}name: '@deepseek-ai\/dsh-agent-preset'$/m)
  assert.match(patch, /^ {8}id: short-story$/m, 'config.id 是会话保存的 preset 标识符')
  assert.match(patch, /^ {8}name: 短篇小说模式$/m)
  assert.match(patch, /^ {8}description: /m)
  assert.match(patch, /^ {8}order: 5$/m, '官方预设占 1–4，本模式排在其后')
})

test('the plugin row resolves by bare package name, never by path or expression', async () => {
  const patch = await read(COMPOSITION)
  assert.match(patch, /- id: story-tools\n\s+name: dsh-story-mode$/m)
  // loader 只对 config 插值；name 会原样丢给 import()，`!!js` 名字整行报错。
  assert.doesNotMatch(patch, /^\s*name:\s*!!js/m)
  // config.plugins 里的相对路径不会被启动器改写：它会按 profile 目录解析。
  assert.doesNotMatch(patch, /^\s*name:\s*\.\.?\//m)
  // preset 树的 baseUrl 是 profile 目录，包内路径必须在运行时问出来。
  assert.match(patch, /createRequire\(baseUrl\)\.resolve\('dsh-story-mode\/package\.json'\)/)
  assert.doesNotMatch(patch, /[A-Za-z]:\\/, 'patch 里不该出现机器相关的绝对路径')
  assert.doesNotMatch(patch, /file:\/\//)
})

test('reviewers are persistent subagents: continuable spawn plus send_message control', async () => {
  const composition = await read(COMPOSITION)
  assert.match(composition, /name:\s*'@deepseek-ai\/dsh-tool-subagent'/)
  assert.match(composition, /backgroundMode:\s*continuable/)
  assert.doesNotMatch(composition, /backgroundMode:\s*one-shot/)
  assert.match(composition, /name:\s*'@deepseek-ai\/dsh-tool-subagent-control'/)
  assert.match(composition, /name:\s*'@deepseek-ai\/dsh-tool-subagent-control\/list-agents'/)
  // fork 会把主代理的大纲与写作推理一起复制给读者，审读独立性就没了。
  assert.doesNotMatch(composition, /provider:\s*fork/)
})

test('the dispatch budget caps new reviewers and mandates reuse', async () => {
  const panel = await read(PANEL)
  const workflow = await read(WORKFLOW)
  const skill = await read(SKILL)
  const composition = await read(COMPOSITION)
  // 宿主的 maxActiveSubagents 默认 8，池满再派会被直接拒绝；四处常驻/必读文本
  // 都必须把"6 位上限 + 复用原读者 + 先看在场读者"讲清楚，少一处就会退回
  // "每版都新派一位"——v1.2.0 的实测档案里就是这么攒出 19 份报告的。
  for (const [label, text] of [['审读面板', panel], ['共用写作流程', workflow], ['技能入口', skill], ['persona', composition]]) {
    assert.match(text, /不超过 6 位/, `${label} 必须写明新建审读子代理的上限`)
    assert.match(text, /send_message/, `${label} 必须要求复核走 send_message 复用原读者`)
    assert.match(text, /list_agents/, `${label} 必须要求派发前先看在场读者`)
  }
  // 面板是判据的源头：机制、上限表与额度用尽的处置都要在里面。
  assert.match(panel, /## 派发预算/)
  assert.match(panel, /maxActiveSubagents/)
  assert.match(panel, /ACTIVATION_LIMIT_REACHED/)
  assert.match(panel, /复用它的名额/)
  assert.match(panel, /B3 \/ B4 \/ B5 \| 命中各自触发条件 \| 合计最多 3/)
  assert.match(panel, /一次会话（一篇文章从接稿到交付）新建的审读子代理不超过 6 位/)
  assert.match(panel, /因额度未派 X，该项待审/)
  // 复用是默认动作，不是可选项。
  assert.match(panel, /复用是默认动作，不是省事的选择/)
  assert.match(workflow, /“每版都派”不是“每版都新建”/)
  assert.doesNotMatch(panel, /每版都派一位新读者/)
})

test('logic review stays after the draft; only the relationship axis runs at plan stage', async () => {
  const panel = await read(PANEL)
  const workflow = await read(WORKFLOW)
  const skill = await read(SKILL)
  const readme = await read('README.md')
  // 方案阶段那一次是关系轴的"计划检查"（只有节拍表与人物卡），逻辑审读是完稿后的
  // 常规轮次（读正文、核设定与因果）。把两者说成一件事，会让人以为逻辑审读在动笔前
  // 就做过了——那正是这一版要修掉的表述。
  assert.match(panel, /第 1 条不是逻辑审读，别记错顺序/)
  assert.match(panel, /逻辑审读是第 2 条/)
  assert.match(panel, /常规逻辑审读在完稿之后/)
  assert.match(panel, /默认派，在完稿之后/)
  assert.match(workflow, /逻辑审读也在内——都在完稿之后/)
  assert.match(workflow, /方案阶段的 §4\.0 是\*\*计划检查\*\*，不是逻辑审读/)
  assert.match(skill, /逻辑审读本身仍在完稿之后/)
  assert.match(readme, /逻辑审读在完稿之后/)
  // 被取代的旧写法不能回来。
  assert.doesNotMatch(panel, /方案阶段（§4\.0 的关系轴审读）建一次，成稿后发给它复核/)
  assert.doesNotMatch(workflow, /方案阶段的 §4\.0 就用\*\*将来要读正文的那位 B2\*\*/)
  assert.doesNotMatch(readme, /B2 一位（方案阶段建，成稿后发给它复核）/)
})

test('each review role owns its row: fixed persona plus a read-only tool filter', async () => {
  const composition = await read(COMPOSITION)
  for (const { file, tool } of ROLES) {
    assert.match(composition, new RegExp(`toolName: ${tool}\\b`), `${tool} 必须有自己的工具行`)
    // persona 必须由那一行自己从角色文件读出：真装配的等价物在
    // scripts/verify-composition.mjs（它会在临时解析环境里求值，并与角色文件**逐字比对**）。
    const persona = composition.match(new RegExp(`toolName: ${tool}[\\s\\S]*?persona: !!js "([^"]+)"`))
    assert.ok(persona, `${tool} 必须用 !!js 从角色人设文件读 persona`)
    assert.ok(persona[1].includes(`reviewers/${file}`), `${tool} 的 persona 必须指向 ${file}`)
    assert.ok((await read(`${REVIEWER_DIR}/${file}`)).trim().length > 0, `${file} 不能为空`)
  }
  // 只在角色行上限制工具：allow 只列读类工具，deny 拿掉写入与再委派。
  const filters = composition.match(/toolFilter:/g) ?? []
  assert.equal(filters.length, ROLES.length, '每个角色行各有一个 toolFilter')
  assert.equal((composition.match(/allow: \[read, read_image, str_replace_editor, glob, grep\]/g) ?? []).length, ROLES.length)
  assert.equal((composition.match(/deny: \[write, edit, present, subagent, send_message, interrupt_agent, list_agents\]/g) ?? []).length, ROLES.length)
  assert.doesNotMatch(composition, /backgroundMode:\s*one-shot/)
})

test('the flow entry, shared writing workflow and panel preserve reviewer reuse', async () => {
  for (const file of [PANEL, SKILL, WORKFLOW]) {
    const text = await read(file)
    assert.match(text, /send_message/, `${file} 必须说明改稿后的复核走 send_message`)
    assert.match(text, /run_in_background: false/, `${file} 必须警告前台调用会退化成一次性会话`)
  }
  const panel = await read(PANEL)
  assert.match(panel, /list_agents/)
  assert.match(panel, /复用/)
  assert.match(panel, /最终盲读[\s\S]{0,60}新(读者|开)/)
  assert.match(panel, /references\/reviewers\//, '面板必须说明角色人设住在哪里')
  for (const { tool } of ROLES) assert.ok(panel.includes(tool), `面板的角色表必须列出 ${tool}`)
})

test('B3 and B4 carry observable dispatch conditions instead of a judgement call', async () => {
  const panel = await read(PANEL)
  // v1.1.2 的写法是"场景顺序、篇幅或节奏需检查"——那句话对任何一篇都成立，
  // 于是条件恒真、角色从不触发。这里钉住换成可观测判据后的样子。
  assert.doesNotMatch(panel, /场景顺序、篇幅或节奏需检查/)
  assert.doesNotMatch(panel, /口吻、视角、叙述方式和句子需检查/)
  assert.match(panel, /超过 5000 字/)
  assert.match(panel, /作者对口吻、视角、叙述方式提过要求/)
  assert.match(panel, /条件满足就派/)
  // 角色分工不能互相兼任，否则五个角色退化成同一个检查做五遍。
  assert.match(panel, /B5 不由 B2 兼任/)
  assert.match(panel, /B3 不由 B1 兼任/)
  assert.match(panel, /B4 不由主代理自查代替/)
  // 面板只留规则；模板已经迁到角色人设里，面板不该再抄一遍。
  assert.doesNotMatch(panel, /你是独立读者/)
  assert.doesNotMatch(panel, /你是故事逻辑审读员/)
})

test('the relationship axis is a first-class pass, not a by-product of consistency checks', async () => {
  // 一次实测暴露的失效形态：五个角色的报告清单全在问"这里有没有矛盾"，
  // 于是"这一跳有没有依据"没人问——一份处处自洽、主轴空心的稿子被当成
  // "没有大结构问题"交付。下面几处一起构成那道缺口，缺一处就退回去。
  const panel = await read(PANEL)
  const workflow = await read(WORKFLOW)
  const skill = await read(SKILL)
  const b2 = await read(`${REVIEWER_DIR}/b2-story-logic.md`)

  // 1. 面板里必须有一节，把两类问题分开写，并点明它是 B2 的职责（不是新角色）。
  assert.match(panel, /## 4\.0 关系轴审读/)
  assert.match(panel, /一致性/)
  assert.match(panel, /充分性/)
  assert.match(panel, /由 \*\*B2 承担\*\*/)
  // 两个时机都必须在面板里出现：方案阶段先跑，成稿后核一遍。
  assert.match(panel, /方案阶段（默认，必做，先于任何正文落地）/)
  assert.match(panel, /首次成稿后/)
  // 不接受概括结论。
  assert.match(panel, /不接受“整体尚可”|不接受"整体尚可"/)
  // 关系轴不能由另外四个角色兼任（它们的边界里都写着不管剧情因果）。
  assert.match(panel, /关系轴不由 B1\/B3\/B4\/B5 兼任/)

  // 2. "留白"这条护栏必须写明不适用于主轴——否则它会把唯一能报缺口的读者也堵死。
  assert.match(panel, /不适用于主轴/)
  assert.match(panel, /他动没动过心/)

  // 3. B2 的人设里要有两组逐条引用的必答项，以及"全可否认 = 缺口"的判据。
  assert.match(b2, /## 关系轴/)
  assert.match(b2, /不可否认/)
  assert.match(b2, /全部条目都可否认/)
  // "有条目不可否认"不等于成立：盲测第三轮实测到这种更隐蔽的形态（15 条不可否认，但全压在关系变化之后）。
  assert.match(b2, /还要看分布/)
  assert.match(b2, /是不是回应/)
  assert.match(b2, /他单独为对方做的/)
  assert.match(b2, /该由谁在哪一拍主动一次/)
  assert.match(b2, /推动者分布/)
  assert.match(b2, /拒绝.*整体尚可|不接受“整体尚可”|不接受"整体尚可"/)
  // 报告清单里必须有一个槽位点名这一节，否则它会退回成"可选补充"。
  assert.match(b2, /\*\*关系轴四组问答\*\*/)
  // 字数上限必须对关系轴放宽：实测两版都写到 3500+ 字，压字数会把必答项写空。
  // 盲测里新版仍只写 1276 汉字并丢掉了逐条表格，所以这里钉的是"不受约束 + 保留逐条列表"。
  assert.match(b2, /关系轴那一节不受 1200 字约束/)
  assert.match(b2, /要保留逐条列表/)
  assert.match(b2, /概括的关系轴结论等于没做这一节/)

  // 4. 节拍表必须有"谁推动"，否则 B2 没有对照物可读。
  assert.match(workflow, /关系轴：每一拍都要能回答/)
  assert.match(workflow, /推动者/)
  assert.match(workflow, /不改变任何一方状态的拍，是重复场景/)
  assert.match(workflow, /不可否认/)
  // 5. 方案阶段先跑（C4：最便宜的拦截），且"免确认"不能跳过它。
  assert.match(workflow, /### 4\.0 关系轴审读/)
  assert.match(skill, /方案先过关系轴审读/)
  assert.match(skill, /不因"免确认"而跳过|不因“免确认”而跳过/)
  // 6. "我没看懂"落在主线上按结构问题处理，不做句子级修补。
  assert.match(workflow, /作者的“我没看懂”是指令|作者的"我没看懂"是指令/)
  assert.match(skill, /作者说"我没看懂"是指令|作者说“我没看懂”是指令/)
})

test('关系轴的起点组：露出有据可引不等于起点有据可引', async () => {
  // 第二次实测暴露的失效形态（v1.2.1）：v1.2.0 把"要没有露出"管住了，但没管
  // "要从哪儿来"。一篇 17,900 字的稿子在关系轴跑了三轮、露出清单逐条引得到、
  // 推动者分布也平衡的情况下，作者仍然读出"没有人味"——因为两个人的动心起点
  // 都在开篇之前，正文只用叙述者的句子交代（"他没有理由去分辨，他分辨了"
  // "我画你的手，是去年十月开始的"），没有一场戏交代为什么会看上这个人。
  // 下面几处钉住新契约，缺一处就退回"清点露出"的老形态。
  const panel = await read(PANEL)
  const workflow = await read(WORKFLOW)
  const b2 = await read(`${REVIEWER_DIR}/b2-story-logic.md`)

  // 1. B2 必须有一组先做、且点名它管的是"要"的来路，不是"要"本身。
  assert.match(b2, /### 第零组：想要从哪儿来/)
  assert.match(b2, /双方都要答，被动的那一方也要答/)
  // 判据必须是硬的：只有叙述者说得出的理由等于没有理由。
  assert.match(b2, /只有叙述者说得出/)
  // 不可替代性要能被检验（换一个对象还成立就不算）。
  assert.match(b2, /可不可替代/)
  assert.match(b2, /叙述者替它交代/)
  // 缺的起点补在开篇之前，而不是就近补一句注。
  assert.match(b2, /需在开篇前补一场/)
  // 成稿后的回引必须单独做一次，不能拿第一组的条目充当证据。
  assert.match(b2, /答不了"他为什么会动心"|答不了“他为什么会动心”/)

  // 2. "留白"这条护栏要同时管住两种滥用：不能拿它放过"有没有"，也不能拿它放过"为什么"。
  assert.match(b2, /"为什么是这个人"不能|“为什么是这个人”不能/)
  assert.match(panel, /"为什么是这个人"不能|“为什么是这个人”不能/)
  assert.match(panel, /"要"没有起点|“要”没有起点/)
  // 面板的成稿时机也要点名起点单独回引。
  assert.match(panel, /第零组的起点与由来单独回引一次/)

  // 3. 规划阶段必须为两边各写一条起点，并写明它不能只靠职务或身份。
  assert.match(workflow, /起点：两个人的动心各有各的来路/)
  assert.match(workflow, /注意起点/)
  assert.match(workflow, /不能只依赖职务或身份/)
  assert.match(workflow, /不可替代/)
  assert.match(workflow, /补在开篇之前/)
  // 人物卡里"动机"（当下要什么）不能顶替起点（这份要的来路）。
  assert.match(workflow, /两者不能互相顶替/)
  // 方案阶段的 §4.0 必答项要含起点，成稿后第一次也核它。
  assert.match(workflow, /为什么只对这个人成立/)
  assert.match(workflow, /双方起点.*是否真的落在文本上|是否真的落在文本上/)

  // 4. 报告清单里的槽位数量必须跟着改，否则起点组会退回"可选补充"。
  assert.match(b2, /\*\*关系轴四组问答\*\*/)
})

test('dialogue function and character knowledge are checked, not just line shape', async () => {
  // 实测的第二种失效：全篇台词每句都在交付信息或下判词，读起来像双方在念台词；
  // 同时"看穿"的能力没有依据，被作者读成上帝视角。lint 的七条规则全是字面形状，
  // 一条也测不到这个——所以判据必须落在规划与 B2 的必答项里。
  const workflow = await read(WORKFLOW)
  const b2 = await read(`${REVIEWER_DIR}/b2-story-logic.md`)
  const panel = await read(PANEL)
  const contract = await read('skills/writing-style-contract/SKILL.md')

  // 规划阶段为"无功能交流"留位置（契约第四节列了形式，但成稿里常常一个都没落地）。
  assert.match(workflow, /台词的功能分布/)
  assert.match(workflow, /无功能/)
  assert.match(contract, /随口附和、确认听清、自我纠正、绕开问题/)
  // 看穿要单向向下、且当场有证据。
  assert.match(workflow, /单向、向下/)
  assert.match(workflow, /地位更低或更被动/)
  // B2 的第三组必答项：抄不出依据就是缺口，并给出可照抄的对照。
  assert.match(b2, /第三组：谁比读者先知道/)
  assert.match(b2, /抄不出依据的，报缺口/)
  assert.match(b2, /你站得太近了/)
  assert.match(b2, /你心事太重/)
  // 这一组必须与 B4 的视角检查划清界限，否则两边互相让。
  assert.match(b2, /它不是视角问题/)
  assert.match(panel, /上帝视角|比读者先知道/)
})

test('the persona stays identity-only and the review conditions live in the panel', async () => {
  const composition = await read(COMPOSITION)
  const persona = composition.match(/prefix: \|-\r?\n([\s\S]*?)\r?\n\s*- id: agent-instructions/)?.[1] ?? ''
  assert.ok(persona.length > 0, 'persona prefix 必须还在')
  // 流程规则下沉到参考文件，人设不该再背着它们；常驻文本的每一句都会随每个子代理重发。
  assert.doesNotMatch(persona, /ask_user_question/)
  assert.doesNotMatch(persona, /人物卡和节拍/)
  assert.doesNotMatch(persona, /静默|缓存/)
  // 但"角色池存在、触发条件在面板里"这条指路必须留在常驻上下文里。
  assert.match(persona, /subagent_review_/)
  assert.match(persona, /触发条件见面板/)
})

test('story_lint is documented as a self-check tool, not a review input', async () => {
  const skill = await read(SKILL)
  const workflow = await read(WORKFLOW)
  const readme = await read('README.md')
  assert.match(skill, /它不进审读流程/)
  assert.match(workflow, /不进审读流程/)
  assert.match(readme, /不进审读流程/)
  const panel = await read(PANEL)
  // 审读面板里不该再把 lint 线索列为某个角色的输入。
  assert.doesNotMatch(panel, /lint 线索/)
})

test('workflow references resolve from their source files within the packaged skills', async () => {
  const skillsRoot = resolve(root, SKILLS)
  const visited = new Set()
  async function visit(file) {
    if (visited.has(file)) return
    visited.add(file)
    const text = await readFile(file, 'utf8')
    assert.ok(text.trim(), `${file} must not be empty`)
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)) {
      const target = resolve(dirname(file), match[1])
      const fromSkills = relative(skillsRoot, target)
      assert.ok(!isAbsolute(fromSkills) && !fromSkills.startsWith('..'), `${target} must stay in the packaged skills`)
      await visit(target)
    }
  }
  await visit(resolve(root, SKILL))
  assert.ok(visited.has(resolve(root, WORKFLOW)), 'shared writing workflow must be reachable from the entry')
  assert.ok(visited.has(resolve(root, PANEL)), 'review panel must be reachable from the entry')
  const manifest = JSON.parse(await read('package.json'))
  assert.ok(manifest.files.includes('skills'), 'skill resources must be included in the package')
  assert.ok(!manifest.files.includes('presets'), 'presets/ no longer exists: the preset is the patch row')
})

test('the composition keeps every row this writing mode depends on', async () => {
  const composition = await read(COMPOSITION)
  // 少一行不一定报错，只会静默少一项能力：没有 present 就没法交付稿件，没有
  // ask_user 就没法在接稿时一次问清约束，没有 tool-fs-search 就只能通读改稿。
  // 所以把"没它就不成立"的行全部点名钉住。
  const required = [
    'preset-short-story',
    'persona', 'agent-instructions',
    'tool-fs', 'tool-fs-search', 'tool-str-replace-editor', 'story-tools',
    'skill-filesystem', 'tool-skill',
    'compaction', 'compaction-basic', 'command-compact', 'tool-result-pruner',
    'tool-subagent', ...ROLES.map(({ tool }) => tool.replace(/^subagent_/, 'tool-subagent-').replace(/_/g, '-')),
    'tool-subagent-control', 'tool-subagent-list-agents',
    'tool-ask-user', 'command-goal', 'tool-goal', 'tool-web', 'present',
  ]
  for (const id of required) {
    assert.match(composition, new RegExp(`^\\s*- id: ${id}\\s*$`, 'm'), `组合里缺了 ${id} 这一行`)
  }
})

test('both skills are mounted into this preset scope only', async () => {
  const composition = await read(COMPOSITION)
  // 一个技能根，两份技能；都从包内挂载，用户根一个副本都不放。
  const dirs = composition.match(/customSkillDirs:\s*\r?\n\s*- !!js "([^"]+)"/)?.[1] ?? ''
  assert.ok(dirs.includes("'skills'"), 'customSkillDirs 必须指向包内 skills/')
  // 只看表达式本身：文件里的注释会解释"为什么不放用户根"，那是说明不是配置。
  assert.doesNotMatch(dirs, /DSH_HOME|\.dsh/, '技能根不该落在用户目录')
  assert.match(dirs, /createRequire\(baseUrl\)\.resolve\('dsh-story-mode\/package\.json'\)/)
  for (const skill of ['short-story', 'writing-style-contract']) {
    assert.ok((await read(`${SKILLS}/${skill}/SKILL.md`)).trim().length > 0, `${skill} 必须有正文`)
  }
})

/** 一份"全部正常"的自检报告，用来单独验证渲染与计数。 */
function cleanReport(overrides = {}) {
  return {
    root: 'C:/pkg',
    home: 'C:/home',
    version: '1.1.1',
    viaProfile: true,
    profileState: { present: true, profile: 'desktop', installedAt: 'C:/pkg', bundled: true, resolvable: true, override: null },
    manifest: { parses: true, hasBom: false, declaresBundle: true, filesIncludeSkills: true },
    patch: {
      present: true,
      hasInsert: true,
      presetRow: true,
      presetPlugin: true,
      presetId: true,
      bareToolsRow: true,
      jsRowNames: [],
      relativeRowNames: [],
      resolvesPackage: true,
      pathReadCount: 7,
      unanchoredPathReads: [],
      riskyScalars: [],
      hasLineComment: false,
      customSkillDirs: true,
      reviewerRows: {},
      reusable: true,
    },
    packageFiles: {
      libEntry: true,
      flowSkill: true,
      workflow: true,
      panel: true,
      contract: true,
      reviewers: { b1: true, b2: true, b3: true, b4: true, b5: true },
    },
    reviewersComplete: true,
    reviewersRoleBased: true,
    skill: { present: false, owned: false, dest: null, markerVersion: null },
    legacy: { present: false, ours: false, isLink: false, path: null },
    live: {
      status: 'ok',
      roster: { status: 'ok', isDefault: false, name: '短篇小说模式', order: 5 },
      composition: { status: 'ok', broken: null, rows: 24, active: 24 },
      skills: { status: 'ok', names: ['short-story', 'writing-style-contract'] },
      tools: { status: 'ok', names: ['story_wordcount', 'story_lint', 'story_bible', 'story_doctor'] },
    },
    defaultPreset: null,
    cleanup: 'C:/pkg/scripts/cleanup.mjs',
    ...overrides,
  }
}

test('doctor reports a healthy installation only when the live preset is mounted', () => {
  const ok = renderDoctor(cleanReport())
  assert.match(ok, /插入了 `preset-short-story` 行 \| 是 \|/)
  assert.match(ok, /（活体）roster 里有 short-story \| 是 \|/)
  assert.match(ok, /（活体）本模式没有被判 broken \| 是 \|/)
  assert.match(ok, /## 结论[\s\S]*一切正常/)

  // 运行时看不到模式＝没装起来，不能给"一切正常"。
  const missing = renderDoctor(cleanReport({ live: { status: 'ok', roster: { status: 'missing', ids: ['standard'] } } }))
  assert.match(missing, /运行时 roster 里没有 short-story/)
  assert.doesNotMatch(missing, /一切正常/)
})

test('doctor refuses to call an unmounted or broken preset healthy', () => {
  const broken = renderDoctor(cleanReport({
    live: {
      status: 'ok',
      roster: { status: 'ok', isDefault: false },
      composition: { status: 'ok', broken: 'story-tools (dsh-story-mode): never started', rows: 24, active: 23 },
    },
  }))
  assert.match(broken, /运行时报告本模式 broken/)
  assert.match(broken, /story-tools \(dsh-story-mode\): never started/)
  assert.doesNotMatch(broken, /一切正常/)
})

test('doctor flags the patch shapes that make the row unloadable', () => {
  const jsName = renderDoctor(cleanReport({
    patch: { ...cleanReport().patch, jsRowNames: ['name: !!js'], bareToolsRow: false },
  }))
  assert.match(jsName, /有行的 name 写成 !!js/)
  assert.match(jsName, /story-tools 行没有用裸包名/)

  const relative = renderDoctor(cleanReport({
    patch: { ...cleanReport().patch, relativeRowNames: ['../../lib/index.js'] },
  }))
  assert.match(relative, /有行的 name 写成相对路径/)

  const noInsert = renderDoctor(cleanReport({
    patch: { ...cleanReport().patch, hasInsert: false, presetRow: false },
  }))
  assert.match(noInsert, /不是 insert 层/)
  assert.match(noInsert, /patch 没有插入 preset-short-story 行/)

  const unanchored = renderDoctor(cleanReport({
    patch: { ...cleanReport().patch, unanchoredPathReads: ['readFileSync(relative)'] },
  }))
  assert.match(unanchored, /没有走 createRequire\(baseUrl\)/)
})

test('doctor reports missing skills and reviewers instead of a healthy installation', () => {
  const report = renderDoctor(cleanReport({
    packageFiles: { ...cleanReport().packageFiles, workflow: false, contract: false, reviewers: { b1: true, b2: false, b3: true, b4: true, b5: true } },
    reviewersComplete: false,
    reviewersRoleBased: false,
    live: {
      status: 'ok',
      roster: { status: 'ok', isDefault: false },
      composition: { status: 'ok', broken: null, rows: 24, active: 24 },
      skills: { status: 'ok', names: ['short-story'] },
      tools: { status: 'ok', names: ['story_wordcount'] },
    },
  }))
  assert.match(report, /包内缺少写作技能的 references\/writing-workflow\.md/)
  assert.match(report, /包内缺少审读角色人设文件/)
  assert.match(report, /审读角色没有各自成行/)
  assert.match(report, /本作用域里技能不齐/)
  assert.match(report, /本作用域里 story_\* 工具只有 1 个/)
  assert.doesNotMatch(report, /一切正常/)
})

test('doctor warns before uninstall when the mode is the selected default', () => {
  const report = renderDoctor(cleanReport({
    live: {
      status: 'ok',
      roster: { status: 'ok', isDefault: true },
      composition: { status: 'ok', broken: null, rows: 24, active: 24 },
      skills: { status: 'ok', names: ['short-story', 'writing-style-contract'] },
      tools: { status: 'ok', names: ['story_wordcount', 'story_lint', 'story_bible', 'story_doctor'] },
    },
  }))
  assert.match(report, /你的默认模式就是本模式/)
  assert.match(report, /- 默认预设指向本模式，卸载前必须先清理/)
})

test('doctor says plainly when the live probe is unavailable', () => {
  const report = renderDoctor(cleanReport({ live: { status: 'unavailable', reason: '独立调用' } }))
  assert.match(report, /（活体）运行时检查 \| 未取到（独立调用） \|/)
  assert.match(report, /静态检查全部通过/)
  assert.doesNotMatch(report, /一切正常/)
})

test('story_doctor is a callable registry definition, not just a renderer', async () => {
  // 这一条钉住一次真实事故：`makeTool` 收的是 `run`，写成 `execute` 时
  // 直接调用 runDoctor()/renderDoctor() 的测试全都通过，只有**注册表真调用一次**
  // 才会暴露 "run is not a function" —— 而那正是模型点下去的那一刻。
  const definition = doctorTool()
  assert.equal(definition.name, 'story_doctor')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output?.render, 'function')
  const result = await definition.execute({}, { signal: undefined })
  assert.equal(typeof result.text, 'string')
  assert.match(result.text, /# dsh-story-mode 安装自检/)
  assert.match(result.text, /## 结论/)
})
