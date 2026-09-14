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
const FULL_STORY = 'presets/short-story/skills/short-story/references/full-story-workflow.md'

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

test('the flow entry, full-story workflow and panel preserve reviewer reuse', async () => {
  for (const file of [SKILL, FULL_STORY, PANEL]) {
    const text = await read(file)
    assert.match(text, /send_message/, `${file} 必须说明改稿后的复核走 send_message`)
    assert.match(text, /run_in_background: false/, `${file} 必须警告前台调用会退化成一次性会话`)
  }
  const panel = await read(PANEL)
  assert.match(panel, /list_agents/)
  assert.match(panel, /复用/)
  assert.match(panel, /最终盲读[\s\S]{0,60}新(读者|开)/)
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
  assert.ok(visited.has(resolve(root, FULL_STORY)), 'complete-story workflow must be reachable from the entry')
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
    presetFullStoryWorkflowPresent: true,
    presetReviewPanelPresent: true,
    presetStyleSkillPresent: true,
    presetStyleSkillMounted: true,
    presetReviewersReusable: true,
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

test('doctor reports a missing full-story workflow instead of a healthy installation', () => {
  const report = renderDoctor(cleanReport({ presetFullStoryWorkflowPresent: false }))
  assert.match(report, /完整故事流程[^\n]*无法加载/)
  assert.match(report, /包内缺少写作技能的 references\/full-story-workflow\.md/)
  assert.doesNotMatch(report, /一切正常/)
})
