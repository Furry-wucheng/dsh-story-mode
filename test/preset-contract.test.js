import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDoctor } from '../lib/doctor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

const COMPOSITION = 'presets/short-story/agent.cordis.yml'
const PANEL = 'presets/short-story/skills/short-story/references/review-panel.md'
const SKILL = 'presets/short-story/skills/short-story/SKILL.md'

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

test('the flow skill and the panel both spell out reuse instead of re-dispatching', async () => {
  for (const file of [SKILL, PANEL]) {
    const text = await read(file)
    assert.match(text, /send_message/, `${file} 必须说明改稿后的复核走 send_message`)
    assert.match(text, /run_in_background: false/, `${file} 必须警告前台调用会退化成一次性会话`)
  }
  const panel = await read(PANEL)
  assert.match(panel, /list_agents/)
  assert.match(panel, /复用/)
  assert.match(panel, /最终盲读[\s\S]{0,60}新(读者|开)/)
})

test('a new story asks before drafting', async () => {
  const composition = await read(COMPOSITION)
  const skill = await read(SKILL)
  for (const text of [composition, skill]) {
    assert.match(text, /ask_user_question/)
  }
  assert.match(skill, /一次问完/)
  assert.match(skill, /篇幅档位由作者选/)
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
