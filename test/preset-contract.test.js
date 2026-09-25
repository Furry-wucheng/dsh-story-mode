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
  // 需要复核时复用原读者；纯文字小改不为走流程而新建读者。
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
  assert.match(workflow, /纯措辞、标点小改不重跑/)
  assert.match(panel, /纯措辞或标点修改无需逐次派发/)
  assert.match(skill, /纯措辞、标点及不改变事实与阅读含义的局部润色由主代理回读/)
  assert.doesNotMatch(panel, /每版都派一位新读者/)
})

test('logic review and relationship evidence share the post-draft B2 pass', async () => {
  const panel = await read(PANEL)
  const workflow = await read(WORKFLOW)
  const skill = await read(SKILL)
  const b2 = await read(REVIEWER_DIR + '/b2-story-logic.md')
  assert.match(panel, /关系轴不另派角色/)
  assert.match(panel, /方案阶段独立审读/)
  assert.match(workflow, /所有独立审读都在完稿之后/)
  assert.match(skill, /有关系线时，B2/)
  assert.match(b2, /关系轴与常规逻辑审读同轮完成/)
  assert.doesNotMatch(panel, /方案阶段（默认，必做，先于任何正文落地）/)
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
    if (file === PANEL || file === WORKFLOW) {
      assert.match(text, /run_in_background: false/, `${file} 必须警告前台调用会退化成一次性会话`)
    }
  }
  const panel = await read(PANEL)
  assert.match(panel, /list_agents/)
  assert.match(panel, /复用/)
  assert.match(panel, /最终盲读[\s\S]{0,60}新(读者|开)/)
  assert.match(panel, /references\/reviewers\//, '面板必须说明角色人设住在哪里')
  for (const { tool } of ROLES) assert.ok(panel.includes(tool), `面板的角色表必须列出 ${tool}`)
})

test('specialist review follows the affected risk, not every final version', async () => {
  const panel = await read(PANEL)
  // v1.1.2 的写法是"场景顺序、篇幅或节奏需检查"——那句话对任何一篇都成立，
  // 于是条件恒真、角色从不触发。这里钉住换成可观测判据后的样子。
  assert.doesNotMatch(panel, /场景顺序、篇幅或节奏需检查/)
  assert.doesNotMatch(panel, /口吻、视角、叙述方式和句子需检查/)
  assert.match(panel, /长篇幅、多场景、增删或调序场景/)
  assert.match(panel, /作者有明确文风要求/)
  assert.match(panel, /改动触及该状态链/)
  assert.doesNotMatch(panel, /本轮是交付前的最后一版/)
  // 角色分工不能互相兼任，否则五个角色退化成同一个检查做五遍。
  assert.match(panel, /B5 不由 B2 兼任/)
  assert.match(panel, /B3 不由 B1 兼任/)
  assert.match(panel, /B4 不由主代理自查代替/)
  // 面板只留规则；模板已经迁到角色人设里，面板不该再抄一遍。
  assert.doesNotMatch(panel, /你是独立读者/)
  assert.doesNotMatch(panel, /你是故事逻辑审读员/)
})

test('relationship review checks evidence without imposing a fixed romance formula', async () => {
  const panel = await read(PANEL)
  const workflow = await read(WORKFLOW)
  const b2 = await read(REVIEWER_DIR + '/b2-story-logic.md')
  assert.match(panel, /重要关系转折/)
  assert.match(panel, /不要求“不可否认”的露出/)
  assert.match(panel, /纯措辞小改无需重跑/)
  assert.match(workflow, /不要求每一拍都有状态改变/)
  assert.match(workflow, /允许感情含混/)
  assert.match(b2, /不要强制双方对称地主动/)
  assert.match(b2, /不预设 2000–4000 字篇幅/)
})
test('default writing skills keep optional examples out of the mandatory context', async () => {
  const skill = await read(SKILL)
  const contract = await read('skills/writing-style-contract/SKILL.md')
  const examples = await read('skills/writing-style-contract/references/style-examples.md')
  assert.ok(skill.length + contract.length < 8500)
  assert.match(contract, /references\/style-examples\.md/)
  assert.match(examples, /## 十四、写法示例/)
  assert.doesNotMatch(contract, /### 9\. 一段日常可以没有待兑现的细节/)
})

test('approximate word targets are guidance unless the author sets a hard limit', async () => {
  for (const file of [SKILL, WORKFLOW, REVIEWER_DIR + '/b2-story-logic.md']) {
    const source = await read(file)
    assert.match(source, /±15%/, `${file} 应允许近似目标浮动`)
    assert.match(source, /精确字数/, `${file} 应保留作者的精确字数要求`)
  }
})

test('dialogue and character knowledge remain contextual checks', async () => {
  const workflow = await read(WORKFLOW)
  const b2 = await read(REVIEWER_DIR + '/b2-story-logic.md')
  const contract = await read('skills/writing-style-contract/SKILL.md')
  assert.match(workflow, /对话可以有闲谈，也可以直接而紧凑/)
  assert.match(b2, /年龄、身份或地位本身不能证明其判断不可信/)
  assert.match(contract, /随口附和、确认听清、自我纠正、绕开问题/)
  assert.match(b2, /信息来源与动机/)
  assert.doesNotMatch(workflow, /每场至少要有一处“无功能”交流/)
})
test('the persona stays identity-only and the review conditions live in the panel', async () => {
  const composition = await read(COMPOSITION)
  const persona = composition.match(/prefix: \|-\r?\n([\s\S]*?)\r?\n\s*- id: agent-instructions/)?.[1] ?? ''
  assert.ok(persona.length > 0, 'persona prefix 必须还在')
  // 流程规则下沉到参考文件，人设不该再背着它们；常驻文本的每一句都会随每个子代理重发。
  assert.doesNotMatch(persona, /ask_user_question/)
  assert.doesNotMatch(persona, /人物卡和节拍/)
  assert.doesNotMatch(persona, /静默|缓存/)
  // 常驻文本只提示角色池与按需读取面板。
  assert.match(persona, /subagent_review_/)
  assert.match(persona, /准备派发独立审读时再读/)
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
