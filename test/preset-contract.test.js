import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDoctor } from '../lib/doctor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

const COMPOSITION = 'presets/short-story/agent.cordis.yml'
const PANEL = 'presets/short-story/skills/short-story/references/review-panel.md'
const SKILL = 'presets/short-story/skills/short-story/SKILL.md'
const WORKFLOW = 'presets/short-story/skills/short-story/references/writing-workflow.md'
const REVIEWER_DIR = 'presets/short-story/skills/short-story/references/reviewers'
/** 角色、工具名、人设文件、B3/B4 触发条件里必须出现的可观测判据。 */
const ROLES = [
  { role: 'b1', file: 'b1-cold-read.md', tool: 'subagent_review_b1' },
  { role: 'b2', file: 'b2-story-logic.md', tool: 'subagent_review_b2' },
  { role: 'b3', file: 'b3-reading-experience.md', tool: 'subagent_review_b3' },
  { role: 'b4', file: 'b4-style-execution.md', tool: 'subagent_review_b4' },
  { role: 'b5', file: 'b5-physical-continuity.md', tool: 'subagent_review_b5' },
]

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

test('each review role owns its row: fixed persona plus a read-only tool filter', async () => {
  const composition = await read(COMPOSITION)
  for (const { file, tool } of ROLES) {
    assert.match(composition, new RegExp(`toolName: ${tool}\\b`), `${tool} 必须有自己的工具行`)
    // persona 必须由那一行自己从角色文件读出：真装配的等价物在
    // scripts/verify-composition.mjs（它会对文件内容求值并比对首行）。
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
  assert.match(b2, /\*\*关系轴两组问答\*\*/)
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
  const persona = composition.match(/prefix: \|-\r?\n([\s\S]*?)\r?\n\r?\n- id: agent-instructions/)?.[1] ?? ''
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

test('workflow references resolve from their source files within the packaged preset', async () => {
  const presetRoot = resolve(root, 'presets/short-story')
  const visited = new Set()
  async function visit(file) {
    if (visited.has(file)) return
    visited.add(file)
    const text = await readFile(file, 'utf8')
    assert.ok(text.trim(), `${file} must not be empty`)
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)) {
      const target = resolve(dirname(file), match[1])
      const fromPreset = relative(presetRoot, target)
      assert.ok(!isAbsolute(fromPreset) && !fromPreset.startsWith('..'), `${target} must stay in the preset`)
      await visit(target)
    }
  }
  await visit(resolve(root, SKILL))
  assert.ok(visited.has(resolve(root, WORKFLOW)), 'shared writing workflow must be reachable from the entry')
  assert.ok(visited.has(resolve(root, PANEL)), 'review panel must be reachable from the entry')
  const manifest = JSON.parse(await read('package.json'))
  assert.ok(manifest.files.includes('presets'), 'workflow resources must be included in the package')
})

test('the composition stays portable and keeps the contract scoped to this preset', async () => {
  const composition = await read(COMPOSITION)
  assert.doesNotMatch(composition, /[A-Za-z]:\\/, '组成里不该出现机器相关的绝对路径')
  assert.doesNotMatch(composition, /file:\/\//)
  assert.match(composition, /new URL\('skills\/', baseUrl\)/)
  assert.match(composition, /new URL\('\.\.\/\.\.\/skills\/', baseUrl\)/)
})

/** 一份"全部正常"的自检报告，用来单独验证新增那一行的渲染与计数。 */
function cleanReport(overrides = {}) {
  return {
    root: 'C:/pkg',
    home: 'C:/home',
    version: '1.1.1',
    viaProfile: true,
    profileState: { profile: 'desktop', installedAt: 'C:/pkg', bundled: true, officialRosterPresent: true },
    manifest: { parses: true, hasBom: false, declaresBundle: true, filesIncludesPresets: true },
    patch: { present: true, targetsRosterRow: true, restatesShippedRoots: true, resolvesOwnPackage: true, hasLineComment: false },
    presetInPackage: { status: 'ok', pluginRow: '../../lib/index.js', pluginRowResolves: true },
    presetSourcePresent: true,
    presetFlowSkillPresent: true,
    presetWritingWorkflowPresent: true,
    presetReviewPanelPresent: true,
    presetStyleSkillPresent: true,
    presetStyleSkillMounted: true,
    presetReviewersReusable: true,
    presetReviewersRoleBased: true,
    presetReviewerFilesPresent: true,
    reviewerRows: [],
    skill: { present: false, owned: false, dest: null, markerVersion: null },
    legacy: { present: false, ours: false, isLink: false, path: null },
    defaultPreset: null,
    cleanup: 'C:/pkg/scripts/cleanup.mjs',
    ...overrides,
  }
}

test('doctor reports reusable reviewers and fails the check when they are one-shot', () => {
  const ok = renderDoctor(cleanReport())
  assert.match(ok, /审读员可复用（continuable \+ send_message） \| 是 \|/)
  assert.match(ok, /## 结论[\s\S]*一切正常/)

  const degraded = renderDoctor(cleanReport({ presetReviewersReusable: false }))
  assert.match(degraded, /审读员可复用（continuable \+ send_message） \| \*\*否/)
  assert.match(degraded, /- preset 里的审读员不是可复用子代理/)
})

test('doctor reports a missing shared writing workflow instead of a healthy installation', () => {
  const report = renderDoctor(cleanReport({ presetWritingWorkflowPresent: false }))
  assert.match(report, /共用写作流程[^\n]*无法加载/)
  assert.match(report, /包内缺少写作技能的 references\/writing-workflow\.md/)
  assert.doesNotMatch(report, /一切正常/)
})
