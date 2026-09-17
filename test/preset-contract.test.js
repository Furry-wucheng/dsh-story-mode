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
