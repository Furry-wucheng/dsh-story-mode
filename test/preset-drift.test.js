import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

/**
 * 精简层是从完整版**手抄**出来的（两层互不依赖，一行都不共用），代价是抄错会静默
 * 漂移：有人给 `tool-fs-search` 补了必填项只补一处、把 `thresholdChars` 只改一份、
 * 或者改了共用行的 `name` —— 单看任何一份文件都合法，装上去才发现两个模式的能力
 * 不一样了。这份测试就是那个代价的兜底：点名共用的行，逐字比对。
 *
 * 比对口径：只看**有内容的行**（空行与整行注释不参与——注释是"为什么"，两份文件
 * 各写各的理由），并去掉块自己的起始缩进后逐字比对，所以"整块被挪了一级"不算差异，
 * 行内的任何改动都算。
 */
const FULL = 'cordis.patch.yml'
const LITE = 'cordis.lite.patch.yml'
/** 两层共用、因此必须逐字一致的行。 */
const SHARED_ROWS = [
  'tool-fs',
  'tool-fs-search',
  'story-tools',
  'tool-skill',
  'tool-subagent',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-ask-user',
  'present',
]
/** compaction 组：外壳（realm 约束）与三个孩子、以及裁剪器的三个阈值。 */
const COMPACTION_ROWS = ['compaction-basic', 'command-compact', 'tool-result-pruner']

/**
 * 把 patch 文本切成 `id -> 块`。块从 `- id: <id>` 起，到下一个 `- id:`（任何层级，
 * 嵌套组的孩子因此各成一块）或回到同级为止。
 */
function rows(text) {
  const found = new Map()
  let block = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const start = line.match(/^(\s*)- id: (\S+)$/)
    if (start) {
      block = { indent: start[1].length, id: start[2], lines: [line] }
      found.set(start[2], block)
      continue
    }
    if (!block) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (line.length - line.trimStart().length <= block.indent) {
      block = null
      continue
    }
    block.lines.push(line)
  }
  return found
}

/** 去掉块自己的起始缩进（保留块内相对缩进）：只有"整块挪了一级"不算漂移。 */
function normalise(block) {
  return block.lines.map((line) => line.slice(block.indent)).join('\n')
}

/**
 * 切出一行 preset 声明的**整棵子树**（声明行 + `config.plugins` 里的子行）。
 *
 * `rows()` 把每个 `- id:` 都当成新块，所以它读不到某个声明行底下的子行——而审读员的
 * 只读组合恰好全在子行里。这里按缩进归属整块：下一个缩进 ≤ 4 的条目才是下一行声明。
 */
function presetBlock(text, rowId) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `    - id: ${rowId}`)
  if (start < 0) return null
  const collected = []
  for (let index = start; index < lines.length; index += 1) {
    if (index > start && /^ {4}- /.test(lines[index])) break
    collected.push(lines[index])
  }
  return collected.join('\n')
}

/** 漂移就报出**行 id 与两份块**：光说"不一致"没法定位是哪一层需要跟着改。 */
function assertSameRow(id, fullRows, liteRows) {
  const full = fullRows.get(id)
  const lite = liteRows.get(id)
  assert.ok(full, `${FULL} 里缺了共用行 ${id}`)
  assert.ok(lite, `${LITE} 里缺了共用行 ${id}`)
  const expected = normalise(full)
  const actual = normalise(lite)
  if (expected === actual) return
  assert.fail(
    `共用行 \`${id}\` 在两份 patch 里已经漂移（这一行是手抄的，改一份就得改另一份）：\n` +
    `--- ${FULL} ---\n${expected}\n--- ${LITE} ---\n${actual}`,
  )
}

test('the rows both presets share are still character-identical', async () => {
  const fullRows = rows(await read(FULL))
  const liteRows = rows(await read(LITE))
  for (const id of SHARED_ROWS) assertSameRow(id, fullRows, liteRows)
})

test('the compaction group and its pruner thresholds are shared without drift', async () => {
  const full = await read(FULL)
  const lite = await read(LITE)
  const fullRows = rows(full)
  const liteRows = rows(lite)
  for (const id of COMPACTION_ROWS) assertSameRow(id, fullRows, liteRows)
  for (const [label, text] of [[FULL, full], [LITE, lite]]) {
    // 三个孩子必须都在，且 realm 隔离的写法一致（compaction-basic 用 ctx.get 读
    // `toolResultPrune`，裁剪器不与它共享 realm 就会读到一个空服务）。
    for (const id of COMPACTION_ROWS) {
      assert.match(text, new RegExp(`^\\s*- id: ${id}$`, 'm'), `${label} 里缺了 ${id}`)
    }
    assert.match(text, /isolate:\s*\n\s*compaction: true\s*\n\s*toolResultPruner: true/, `${label} 的 realm 隔离写法变了`)
    assert.match(text, /thresholdChars: 8192/, `${label} 的裁剪阈值变了`)
    assert.match(text, /headChars: 4096/, `${label} 的裁剪阈值变了`)
    assert.match(text, /tailChars: 1024/, `${label} 的裁剪阈值变了`)
  }
})

test('the split left the full preset intact: no lite text, six declarations, web and goal kept', async () => {
  const full = await read(FULL)
  // 另起一个文件的唯一承诺就是"原文件不动、它的验证不动"，所以这条要能独立失败。
  assert.doesNotMatch(full, /short-story-lite/)
  assert.doesNotMatch(full, /lite/i, '完整版那一层不该出现任何 lite 字样')
  assert.equal((full.match(/^- insert:[ \t]*$/gm) ?? []).length, 1)
  // 0.2.1：五条审读员声明 + 一条主模式声明。
  assert.equal((full.match(/^ {4}- id: /gm) ?? []).length, 6, 'insert 里应有 5 个审读员 + 1 个主模式')
  for (const role of ['b1', 'b2', 'b3', 'b4', 'b5']) {
    assert.match(full, new RegExp(`^ {4}- id: preset-short-story-review-${role}$`, 'm'), `缺了 ${role} 的只读 preset 声明`)
    assert.match(full, new RegExp(`^ {8}id: story-review-${role}$`, 'm'), `缺了 story-review-${role} 的 config.id`)
  }
  // 五位角色化审读员一位都不能少，也不能变成合并的那一位。
  const reviewerTools = [...full.matchAll(/toolName: (subagent_review\w*)/g)].map((match) => match[1])
  assert.deepEqual(reviewerTools, ['subagent_review_b1', 'subagent_review_b2', 'subagent_review_b3', 'subagent_review_b4', 'subagent_review_b5'])
  for (const id of ['tool-web', 'tool-goal']) {
    assert.match(full, new RegExp(`^\\s*- id: ${id}$`, 'm'), `完整版里不该少了 ${id}`)
  }
  // 0.1.7 的三个配置项在完整版里也要清零：persona/toolFilter 会让挂载抛错，backgroundMode 静默失效。
  assert.doesNotMatch(full, /toolFilter\s*:/, '0.2.1 没有 toolFilter：只读由审读员 preset 的组合保证')
  assert.doesNotMatch(full, /backgroundMode\s*:/, '0.2.1 没有 backgroundMode：每次派发都是后台 activation')
  assert.doesNotMatch(full, /^\s*persona:\s*!!js/m, 'persona 只能作为独立插件行出现，不能挂在工具行上')
  // 审读员 preset 里只有只读组合：编辑器、写/编辑开关、交付、委派、技能、压缩都不该出现。
  const fullRows = rows(full)
  for (const role of ['b1', 'b2', 'b3', 'b4', 'b5']) {
    const block = presetBlock(full, `preset-short-story-review-${role}`)
    assert.ok(block !== null, `缺了 ${role} 的只读 preset`)
    assert.match(block, /name: '@deepseek-ai\/dsh-persona'/, `${role} 的人设挂在它自己的 preset 里`)
    assert.doesNotMatch(block, /tool-str-replace-editor|tool-present|tool-skill|tool-subagent|compaction/,
      `${role} 的 preset 里出现了不属于只读组合的行`)
    assert.match(block, /write: false/, `${role} 的 tool-fs 必须显式关掉 write`)
    assert.match(block, /edit: false/, `${role} 的 tool-fs 必须显式关掉 edit`)
    assert.match(block, /sampleOverCapGlobResults: false/, `${role} 的 tool-fs-search 必须有必填项`)
    // 工具行只写 provider/toolName/agentPreset，并指回这个 preset。
    const toolRow = fullRows.get(`tool-subagent-review-${role}`)
    assert.ok(toolRow, `缺了 ${role} 的工具行`)
    const toolBlock = toolRow.lines.join('\n')
    assert.match(toolBlock, new RegExp(`agentPreset: story-review-${role}\\b`), `${role} 的工具行必须指到自己的只读 preset`)
    assert.doesNotMatch(toolBlock, /persona:|toolFilter:|backgroundMode:/, `${role} 的工具行只写 provider/toolName/agentPreset`)
  }
})

test('both layers declare reviewer presets before the main preset and wire them with agentPreset', async () => {
  // 顺序是 0.2.1 的硬契约：`tool-subagent` 在挂载时校验 agentPreset 指向的声明已经注册，
  // 审读员声明排在主模式之后会让整层 broken（模式在选择器里红着、切不进去）。
  const cases = [
    {
      label: FULL,
      text: await read(FULL),
      mainRowId: 'preset-short-story',
      reviewerRowIds: ['preset-short-story-review-b1', 'preset-short-story-review-b2', 'preset-short-story-review-b3',
        'preset-short-story-review-b4', 'preset-short-story-review-b5'],
      presetIds: ['story-review-b1', 'story-review-b2', 'story-review-b3', 'story-review-b4', 'story-review-b5'],
    },
    {
      label: LITE,
      text: await read(LITE),
      mainRowId: 'preset-short-story-lite',
      reviewerRowIds: ['preset-short-story-review-merged'],
      presetIds: ['story-review-merged'],
    },
  ]
  for (const item of cases) {
    const mainAt = item.text.search(new RegExp(`^ {4}- id: ${item.mainRowId}$`, 'm'))
    assert.ok(mainAt >= 0, `${item.label} 里缺了主模式声明 ${item.mainRowId}`)
    assert.doesNotMatch(item.text, /toolFilter\s*:/, `${item.label} 里还有 toolFilter`)
    assert.doesNotMatch(item.text, /backgroundMode\s*:/, `${item.label} 里还有 backgroundMode`)
    let previousAt = -1
    for (const [index, rowId] of item.reviewerRowIds.entries()) {
      const at = item.text.search(new RegExp(`^ {4}- id: ${rowId}$`, 'm'))
      assert.ok(at >= 0, `${item.label} 里缺了 ${rowId}`)
      assert.ok(at < mainAt, `${item.label}：${rowId} 必须排在主模式 ${item.mainRowId} 之前`)
      assert.ok(at > previousAt, `${item.label}：审读员声明行的顺序固定，${rowId} 排错了`)
      previousAt = at
      assert.match(item.text, new RegExp(`agentPreset: ${item.presetIds[index]}\\b`), `${item.label}：缺少指向 ${item.presetIds[index]} 的工具行`)
    }
  }
})

test('the manifest ships both patch layers and the lite skills in the tarball', async () => {
  const manifest = JSON.parse(await read('package.json'))
  const patches = manifest.dsh?.bundle?.patch
  assert.ok(Array.isArray(patches), 'dsh.bundle.patch 必须是路径数组：一个字符串只装得下一层')
  assert.deepEqual([...patches].sort(), ['./cordis.lite.patch.yml', './cordis.patch.yml'], '两层补丁都要随包发布')
  for (const patch of patches) {
    assert.match(patch, /^\.\//, `bundle patch 必须写成相对包根的路径：${patch}`)
    assert.equal(manifest.exports[patch], patch, `exports 必须导出 ${patch}`)
    assert.ok(manifest.files.includes(patch.slice(2)), `files 必须包含 ${patch}`)
    assert.ok((await read(patch)).trim().length > 0, `${patch} 声明了就必须存在且非空`)
  }
  assert.ok(manifest.files.includes('skills-lite'), 'skills-lite/ 必须随包发布')
  assert.ok(manifest.files.includes('skills'), '完整版的技能也要继续随包发布')
  // 精简层由同一个校验脚本的 --preset lite 档位守着：档位从 verify 里掉了，这一层
  // 就再也没人验了（完整版那一档还在，所以不会有任何报错）。
  assert.match(manifest.scripts.verify, /cordis\.lite\.patch\.yml/, 'verify 必须覆盖精简层')
  assert.match(manifest.scripts.verify, /--preset lite/, 'verify 必须带上精简层的档位')
})
