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

test('the split left the full preset intact: no lite text, five reviewers, web and goal kept', async () => {
  const full = await read(FULL)
  // 另起一个文件的唯一承诺就是"原文件不动、它的验证不动"，所以这条要能独立失败。
  assert.doesNotMatch(full, /short-story-lite/)
  assert.doesNotMatch(full, /lite/i, '完整版那一层不该出现任何 lite 字样')
  assert.equal((full.match(/^- insert:[ \t]*$/gm) ?? []).length, 1)
  assert.equal((full.match(/^ {4}- id: /gm) ?? []).length, 1)
  // 五位角色化审读员一位都不能少，也不能变成合并的那一位。
  const reviewerTools = [...full.matchAll(/toolName: (subagent_review\w*)/g)].map((match) => match[1])
  assert.deepEqual(reviewerTools, ['subagent_review_b1', 'subagent_review_b2', 'subagent_review_b3', 'subagent_review_b4', 'subagent_review_b5'])
  for (const id of ['tool-web', 'tool-goal']) {
    assert.match(full, new RegExp(`^\\s*- id: ${id}$`, 'm'), `完整版里不该少了 ${id}`)
  }
  assert.equal((full.match(/toolFilter:/g) ?? []).length, 5, '每个角色行各有一个 toolFilter')
  assert.match(full, /^\s*allow: \[read, read_image, str_replace_editor, glob, grep\]$/m, '完整版的审读员仍带着编辑器（这是它自己的取舍）')
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
