import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function harness(initial = {}) {
  const files = new Map(Object.entries(initial))
  const tools = new Map()
  const observations = []
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    fs: {
      async resolve(path) { return { displayPath: path } },
      async stat(target) { return files.has(target.displayPath) ? { type: 'file', version: 'v1' } : undefined },
      async readText(target) { return files.get(target.displayPath) },
    },
    emit(...args) { observations.push(args) },
  }
  apply(ctx, {})
  return {
    files, observations,
    async run(name, args = {}, exec = { agent: { session: { header: { cwd: process.cwd() } } } }) {
      return (await tools.get(name).execute({ path: 'draft.md', ...args }, exec)).text
    },
  }
}

test('headings split scenes without counting heading text', async () => {
  const h = harness({ 'draft.md': '# 标题\n\n## 第一场\n\n甲乙。\n\n## 第二场\n\n丙丁戊。' })
  const report = await h.run('story_wordcount')
  assert.match(report, /口径字数：\*\*5\*\*/)
  assert.match(report, /共 2 场/)
  assert.match(report, /切分依据：标题/)
  assert.match(report, /段落：2 段/)
  assert.match(report, /\| 1 \| 2 \|/)
  assert.match(report, /\| 2 \| 3 \|/)
})

test('empty prose and separator-only files have no scenes', async () => {
  for (const body of ['', '# 标题\n\n', '---\n***\n']) {
    const h = harness({ 'draft.md': body })
    const report = await h.run('story_wordcount')
    assert.match(report, /口径字数：\*\*0\*\*/)
    assert.match(report, /共 0 场/)
    assert.match(report, /段落：0 段/)
  }
})

test('scene separators take precedence; separators are not paragraphs', async () => {
  const h = harness({ 'draft.md': '# 标题\n甲乙。\n\n---\n\n## 第二场\n丙丁。\n### 小节\n戊己。' })
  const report = await h.run('story_wordcount')
  assert.match(report, /共 2 场/)
  assert.match(report, /场景分隔符/)
  assert.match(report, /口径字数：\*\*6\*\*/)
  assert.match(report, /段落：3 段/)
})

test('frontmatter is excluded and lint preserves original line numbers', async () => {
  const h = harness({ 'draft.md': '\uFEFF---\r\ntitle: 仿佛\r\n---\r\n# 标题\r\n\r\n他仿佛醒了。' })
  assert.match(await h.run('story_wordcount'), /口径字数：\*\*5\*\*/)
  const lint = await h.run('story_lint', { only: 'template-simile' })
  assert.match(lint, /第 6 行：他仿佛醒了/)
  assert.doesNotMatch(lint, /第 2 行/)
})

test('mixed paragraphs count only quoted text and still report narration repeats', async () => {
  const h = harness({ 'draft.md': '他说：“走。”\n' + '雨水落在空荡的街道上。'.repeat(20) })
  const report = await h.run('story_wordcount')
  assert.match(report, /口径字数：\*\*203\*\*/)
  assert.match(report, /对话近似）：1 字 \/ 占 0.5%/)
  assert.match(report, /雨水.*×20/)
  assert.doesNotMatch(report, /偏闷|偏飘|高于 70|低于 20/)
})

test('quoted repetitions do not leak into narration statistics', async () => {
  const h = harness({ 'draft.md': '“雨水雨水雨水雨水。”他说。' })
  assert.doesNotMatch(await h.run('story_wordcount'), /重复双字组合/)
})

test('nested quotes and supplementary Han characters count once', async () => {
  const h = harness({ 'draft.md': '甲说：“𠮷说「好」。”乙。' })
  const report = await h.run('story_wordcount')
  assert.match(report, /口径字数：\*\*6\*\*/)
  assert.match(report, /对话近似）：3 字 \/ 占 50%/)
})

test('unclosed quotation is reset at paragraph boundary', async () => {
  const h = harness({ 'draft.md': '“好\n\n甲乙。' })
  const report = await h.run('story_wordcount')
  assert.match(report, /对话近似）：1 字 \/ 占 33.3%/)
})

test('uneven confirmed targets are respected', async () => {
  const h = harness({ 'draft.md': '甲'.repeat(10) + '\n---\n' + '乙'.repeat(30) })
  const report = await h.run('story_wordcount', { sceneTargets: '10,30' })
  assert.match(report, /\| 1 \| 10 \| 25% \| 10 \| 0% \|/)
  assert.match(report, /\| 2 \| 30 \| 75% \| 30 \| 0% \|/)
  assert.doesNotMatch(report, /偏重|偏轻|均分/)
})

test('target deviation uses target words as denominator and allows future scenes', async () => {
  const h = harness({ 'draft.md': '甲'.repeat(12) })
  const report = await h.run('story_wordcount', { sceneTargets: '10,30' })
  assert.match(report, /\| 1 \| 12 \| 100% \| 10 \| \+20% \|/)
  assert.match(report, /另有 1 场目标尚无对应正文/)
})

test('no targets means no invented quota verdict', async () => {
  const h = harness({ 'draft.md': '甲\n---\n' + '乙'.repeat(50) })
  const report = await h.run('story_wordcount')
  assert.match(report, /未提供 sceneTargets/)
  assert.doesNotMatch(report, /偏重|偏轻|各项指标都在/)
})

test('length bands use the author-selected ranges at their boundaries', async () => {
  for (const [tier, min, max] of [['flash', 3000, 5000], ['short', 5000, 10000], ['novelette', 10000, 20000], ['series', 3000, 10000]]) {
    const h = harness()
    for (const length of [min, max]) {
      h.files.set('draft.md', '甲'.repeat(length))
      assert.doesNotMatch(await h.run('story_wordcount', { tier }), /参考下限|参考上限/)
    }
    h.files.set('draft.md', '甲'.repeat(min - 1))
    assert.match(await h.run('story_wordcount', { tier }), /参考下限.*少 1 字；档位仅供参考/)
    h.files.set('draft.md', '甲'.repeat(max + 1))
    assert.match(await h.run('story_wordcount', { tier }), /参考上限.*多 1 字；档位仅供参考/)
  }
})

test('invalid or incomplete targets are rejected', async () => {
  const h = harness({ 'draft.md': '甲\n---\n乙' })
  for (const value of ['', '1', '0,2', '-1,2', '1.5,2', '1,,2', 'x,2', '9007199254740992,2']) {
    await assert.rejects(h.run('story_wordcount', { sceneTargets: value }), /sceneTargets/)
  }
})

test('content versions match across tools and change after revision', async () => {
  const h = harness({ 'draft.md': '甲乙。' })
  const version = (await h.run('story_wordcount')).match(/稿件版本：(\w+)/)[1]
  assert.match(await h.run('story_lint'), new RegExp('稿件版本：' + version))
  h.files.set('draft.md', '甲丙。')
  assert.doesNotMatch(await h.run('story_wordcount'), new RegExp('稿件版本：' + version))
})

test('POV is no longer inferred from pronouns or self compounds', async () => {
  const h = harness({ 'draft.md': '他从自我怀疑中挣脱出来。我沿着河岸走，你见过那条河。与此同时，灯亮了。' })
  for (const pov of ['first', 'third-limited', 'omniscient']) {
    const report = await h.run('story_lint', { pov, only: 'pov-drift' })
    assert.match(report, /不再触发人称正则检查/)
    assert.doesNotMatch(report, /## 视角滑移|叙述里出现第一人称|全知视角词/)
  }
})

test('lint labels words as candidates and leaves dialogue voice to readers', async () => {
  const h = harness({ 'draft.md': '“我明白了，好像是这样。”\n\n他明白了。' })
  const report = await h.run('story_lint')
  assert.match(report, /命中不等于要删/)
  assert.match(report, /第 3 行/)
  assert.doesNotMatch(report, /第 1 行/)
})

test('adverbs before and after dialogue tags are located', async () => {
  const h = harness({ 'draft.md': '“走吧。”她轻声说道。\n\n“好。”他说，声音很低。' })
  const report = await h.run('story_lint', { only: 'emotion-adverb-tag' })
  assert.match(report, /第 1 行/)
  assert.match(report, /第 3 行/)
})

test('misspelled lint rule ids fail instead of claiming no matches', async () => {
  const h = harness({ 'draft.md': '他仿佛醒了。' })
  await assert.rejects(h.run('story_lint', { only: 'template-simlie' }), /未知规则/)
})

test('bible fields must have an exact label and nonempty value', async () => {
  const h = harness({ 'draft.md': '## 林远\n- 身份认证：司机\n- 动机：\n- **关系**：  ' })
  const report = await h.run('story_bible')
  assert.match(report, /身份、动机、关系/)
  assert.match(report, /字段缺失或为空/)
})

test('bible accepts bold fields and deduplicates overlapping aliases', async () => {
  const h = harness({
    'draft.md': '## 林远（别名：小林远 / 林远 / 小林远）\n- **身份**：司机\n- **动机：** 找妹妹\n- 关系：林青的哥哥',
    'prose.md': '小林远走了。林远回来。',
  })
  const report = await h.run('story_bible', { draft: 'prose.md' })
  assert.match(report, /\| 林远 \| 小林远 \| — \| 2 次 \|/)
  assert.match(report, /不代表动机、关系或设定合理/)
})

test('uncarded checks disclose limited scope without pretending to detect new names', async () => {
  const h = harness({
    'draft.md': '## 林远\n- 身份：司机\n- 动机：找人\n- 关系：独居',
    'prose.md': '林远见到陈默。陈默走了。',
  })
  const report = await h.run('story_bible', { draft: 'prose.md' })
  assert.match(report, /不自动识别正文新人物或核验专名拼写/)
  assert.doesNotMatch(report, /人物卡结构与字段齐全/)
})

test('named facts yield candidates even without any character cards', async () => {
  const h = harness({ 'draft.md': '## 已知事实\n- 陈默：前任店主', 'prose.md': '陈默来了。陈默走了。' })
  assert.match(await h.run('story_bible', { draft: 'prose.md' }), /- 陈默/)
})

test('host read observations and missing-file errors remain intact', async () => {
  const h = harness({ 'draft.md': '甲。' })
  await h.run('story_wordcount')
  assert.equal(h.observations[0][0], 'fs/observed')
  await assert.rejects(h.run('story_wordcount', { path: 'missing.md' }), /不存在/)
  await assert.rejects(h.run('story_wordcount', {}, {}), /没有拥有者会话/)
})
