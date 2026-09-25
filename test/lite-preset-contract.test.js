import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

/**
 * 精简版住在**自己的**补丁层里：`cordis.lite.patch.yml` 插入一行 preset 声明
 * （`preset-short-story-lite` / `config.id: short-story-lite`），子插件列表就是
 * 那一行的 `config.plugins`。完整版那一层（`cordis.patch.yml`）一个字都没动，
 * 两层互不依赖——所以两边都要有自己的契约测试：完整版由 preset-contract.test.js
 * 守着，这一层由本文件守着，"手抄的共用行有没有漂移"由 preset-drift.test.js 守。
 *
 * 精简版**有意**少掉的东西（每一条都在补丁文件头写了理由，改之前先读）：
 * 5 位角色化审读员 → 1 位合并审读员；`tool-web` 与 `tool-goal`；
 * 审读员 `allow` 里的 `str_replace_editor`（它带 create / str_replace / insert）。
 */
const COMPOSITION = 'cordis.lite.patch.yml'
const SKILLS_LITE = 'skills-lite'
const LITE_SKILL = 'skills-lite/short-story-lite/SKILL.md'
const MERGED_REVIEWER = 'skills-lite/references/reviewer-merged.md'
const CONTRACT = 'skills/writing-style-contract/SKILL.md'
/** 精简层必须保留的直接子行：少一行不一定报错，只会静默少一项能力。 */
const REQUIRED_ROWS = [
  'persona', 'agent-instructions',
  'tool-fs', 'tool-fs-search', 'tool-str-replace-editor', 'story-tools',
  'skill-filesystem', 'tool-skill',
  'compaction',
  'tool-subagent', 'tool-subagent-review', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-ask-user', 'present',
]
/** compaction 组里的三个孩子（比直接子行低一层）。 */
const REQUIRED_GROUP_ROWS = ['compaction-basic', 'command-compact', 'tool-result-pruner']
/**
 * 契约里最有辨识度的几句：合并人设若把契约正文抄了一份，这几句会跟着出现。
 * 契约是**共用文件**，两个模式读同一份，绝不复制。
 */
const CONTRACT_FINGERPRINTS = [
  '# 文风契约',
  '## 一、默认叙事风格',
  '这是作者没有另行指定时的默认写法',
  '不以词语命中或删除比例判定合格',
]

/** insert 之后的整棵 preset 树；注释行去掉——注释解释"为什么"，不是配置。 */
function presetBlock(patch) {
  const start = patch.search(/^- insert:[ \t]*$/m)
  assert.ok(start >= 0, '补丁必须有一个顶层 insert 层')
  return patch
    .slice(start)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

/** 切出某一个具体子行（`- id: x` 到下一个 `- id:` 为止）：断言只落在它自己身上。 */
function row(block, id) {
  const found = block.match(new RegExp(`- id: ${id}\\n[\\s\\S]*?(?=\\n *- id: |$)`))
  assert.ok(found, `精简层里缺了 ${id} 这一行`)
  return found[0]
}

/** `allow: [a, b]` / `deny: [a, b]` → 工具名数组。 */
function list(value) {
  const raw = value.match(/\[([^\]]*)\]/)?.[1] ?? ''
  return raw.split(',').map((name) => name.trim()).filter(Boolean)
}

test('the lite patch inserts exactly one preset row and touches nothing else', async () => {
  const patch = await read(COMPOSITION)
  // 一个文件一个 preset：`scripts/verify-composition.mjs --preset lite` 与
  // 本文件都只认"顶层 1 条 insert、insert 里 1 行"，多一块就整体失效。
  assert.equal((patch.match(/^- insert:[ \t]*$/gm) ?? []).length, 1, '精简层只允许一个 insert 层')
  assert.equal((patch.match(/^ {4}- id: /gm) ?? []).length, 1, 'insert 里只允许一行 preset 声明')
  assert.match(patch, /^ {4}- id: preset-short-story-lite$/m)
  assert.match(patch, /^ {6}name: '@deepseek-ai\/dsh-agent-preset'$/m)
  assert.match(patch, /^ {8}id: short-story-lite$/m, 'config.id 是会话保存的 preset 标识符')
  const name = patch.match(/^ {8}name: (.*)$/m)?.[1]?.trim() ?? ''
  assert.ok(name.length > 0, 'config.name 不能为空：roster 里要显示它')
  assert.match(name, /精简/, `config.name 必须自报精简档，实际是 ${name}`)
  assert.match(patch, /^ {8}description: \S/m, 'roster 里还要有非空的说明')
  assert.match(patch, /^ {8}order: 6$/m, '完整版占 5，精简版排在它后面')
  // 两层各声明自己的 id：同名会让后注册的那一层覆盖前一层。
  assert.doesNotMatch(patch, /^ {4}- id: preset-short-story$/m)
  assert.doesNotMatch(patch, /^ {8}id: short-story$/m)
})

test('the lite preset arms exactly one reviewer tool: read-only, spawn, continuable', async () => {
  const block = presetBlock(await read(COMPOSITION))
  // 通用出口 `subagent` 留着是有意的（作者说"再找一双眼睛"时唯一的去处），
  // 但它不是审读员：精简层的审读只走 `subagent_review` 这一条。
  const toolNames = [...block.matchAll(/toolName: (\S+)/g)].map((match) => match[1])
  assert.deepEqual(toolNames, ['subagent', 'subagent_review'], '精简层的子代理工具面只有这两行')
  const reviewers = [...block.matchAll(/toolName: (subagent_review\S*)/g)].map((match) => match[1])
  assert.deepEqual(reviewers, ['subagent_review'], '审读工具只能有一个，且不带角色后缀')
  assert.equal((block.match(/toolFilter:/g) ?? []).length, 1, '只有审读行带工具过滤')

  const review = row(block, 'tool-subagent-review')
  assert.match(review, /name: '@deepseek-ai\/dsh-tool-subagent'/, '审读员由 tool-subagent 包提供')
  assert.match(review, /provider: spawn/, 'spawn 后端才能零继承上下文地冷读')
  assert.match(review, /backgroundMode: continuable/, '可续接才能把复核发回同一位读者')
  assert.doesNotMatch(review, /provider:\s*fork/, 'fork 会把主代理的大纲与写作推理复制给读者')
  assert.doesNotMatch(review, /one-shot/, '一次性子代理每次复核都得从头读一遍全文')

  // allow 只列读类工具：`read` 已返回带行号正文，`glob` / `grep` 负责定位。
  const allow = list(review.match(/allow: (\[[^\]]*\])/)?.[1] ?? '')
  assert.deepEqual(allow, ['read', 'read_image', 'glob', 'grep'], '审读员的工具面只能是这四件')
  // 允许 `str_replace_editor` 等于审读员**物理上可写**（view / create / str_replace / insert），
  // 与"只读审读员"的说法不符；它的 schema 还占这个子代理工具面的一半以上。
  // 所以它只能出现在解释"为什么不给"的注释里，配置里一个都不许有。
  assert.ok(!allow.includes('str_replace_editor'), '审读员不能拿到任何可写的编辑器工具')
  assert.doesNotMatch(block, /str_replace_editor/, 'str_replace_editor 只能出现在注释里解释为什么被排除')
  const patch = await read(COMPOSITION)
  const mentions = patch.split(/\r?\n/).filter((line) => line.includes('str_replace_editor'))
  assert.ok(mentions.length > 0, '文件里必须保留"为什么审读员没有编辑器"的说明')
  for (const line of mentions) assert.match(line.trim(), /^#/, 'str_replace_editor 只该出现在注释里')
  // 理由必须留在文件里：光看 allow 列表，下一个人会把"少了编辑器"当成遗漏补回去。
  assert.match(patch, /str_replace_editor[\s\S]{0,120}就不是只读审读员/, '文件里必须说明"为什么审读员没有编辑器"')

  // deny 是兜底：写入、呈现与再委派全部拿掉。`restrict()` 对未注册的工具名抛错，
  // 所以这里只列本组合真实存在的名字，且必须逐个点名。
  const deny = list(review.match(/deny: (\[[^\]]*\])/)?.[1] ?? '')
  assert.deepEqual(
    deny,
    ['write', 'edit', 'present', 'subagent', 'send_message', 'interrupt_agent', 'list_agents'],
    'deny 必须覆盖写入、呈现与再委派',
  )
})

test('the merged reviewer persona reads the role file plus the shared contract, never a copy', async () => {
  const block = presetBlock(await read(COMPOSITION))
  const review = row(block, 'tool-subagent-review')
  const persona = review.match(/persona: !!js "([^"]+)"/)?.[1]
  assert.ok(persona, '审读行必须用 !!js 在挂载时从包内读人设')
  // 两个来源都要在表达式里：合并审读员说明 + 共用的文风契约全文。
  for (const part of ["'skills-lite'", "'references'", "'reviewer-merged.md'", "'skills', 'writing-style-contract'", "'SKILL.md'"]) {
    assert.ok(persona.includes(part), `persona 表达式必须读到 ${part}`)
  }
  assert.equal([...persona.matchAll(/readFileSync\(/g)].length, 2, '两个来源各读一次')
  // 契约必须**拼在角色说明后面**：契约的使用说明要求"先读作者要求、再读正文、最后对照契约"。
  assert.match(persona, /role\s*\+\s*String\.fromCharCode\(10\)\s*\+\s*contract/, '拼装顺序：角色说明在前，契约在后')
  // 双引号标量里的 `\n` 会被 YAML 先变成真换行 → 挂载时 SyntaxError、整个模式挂不上。
  assert.doesNotMatch(persona, /\\n/, '换行只能写 String.fromCharCode(10)')

  // 契约是共用文件：这里只读它，不复制。人设里出现契约正文＝多出一份会漂移的副本。
  const merged = await read(MERGED_REVIEWER)
  const contract = await read(CONTRACT)
  assert.ok(merged.trim().length > 0, `${MERGED_REVIEWER} 不能为空`)
  assert.ok(contract.trim().length > 0, `${CONTRACT} 不能为空`)
  // 指纹本身要成立，否则下面的否定断言是句空话。
  for (const fingerprint of CONTRACT_FINGERPRINTS) {
    assert.ok(contract.includes(fingerprint), `契约里应当有指纹「${fingerprint}」`)
    assert.ok(!merged.includes(fingerprint), `合并人设里抄进了契约正文：「${fingerprint}」`)
  }
})

test('the lite scope mounts two skill roots: the lite flow and the shared contract', async () => {
  const block = presetBlock(await read(COMPOSITION))
  const dirs = [...block.matchAll(/^ *- !!js "([^"]+)" *$/gm)].map((match) => match[1])
  assert.equal(dirs.length, 2, '精简层恰好挂两个技能根')
  const liteRoot = dirs.find((dir) => dir.includes("'skills-lite'"))
  const contractRoot = dirs.find((dir) => dir.includes("'skills', 'writing-style-contract'"))
  assert.ok(liteRoot, '必须有一个根指向包内 skills-lite/')
  assert.ok(contractRoot, '必须有一个根指向共用的文风契约目录')
  assert.notEqual(liteRoot, contractRoot, '两个根是两份技能，不是同一个')
  for (const dir of dirs) {
    // preset 树的 baseUrl 是 profile 目录，包内路径必须在运行时问出来。
    assert.match(dir, /createRequire\(baseUrl\)\.resolve\('dsh-story-mode\/package\.json'\)/, '技能根必须走 createRequire(baseUrl) 问出包根')
    assert.ok(dir.includes("'node:path'"), '包根要拼路径，不能手写分隔符')
    assert.doesNotMatch(dir, /DSH_HOME|\.dsh/, '技能根不该落在用户目录：那会让契约出现在所有模式里')
    assert.doesNotMatch(dir, /[A-Za-z]:[\\/]|file:\/\//, 'patch 里不该出现机器相关的路径')
  }

  // 两个技能文件都得在、都得有正文；`references/` 是材料目录，不是技能。
  for (const file of [LITE_SKILL, CONTRACT]) {
    assert.ok((await read(file)).trim().length > 0, `${file} 不能为空`)
  }
  assert.deepEqual((await readdir(resolve(root, SKILLS_LITE))).sort(), ['references', 'short-story-lite'], 'skills-lite 根下只装精简流程技能')
  await assert.rejects(read(`${SKILLS_LITE}/references/SKILL.md`), /ENOENT/, 'references/ 里没有 SKILL.md，因此不会被当成技能')
})

test('the lite skill is self-contained: no panel to read, one reviewer to reuse', async () => {
  const skill = await read(LITE_SKILL)
  assert.match(skill, /subagent_review/, '技能必须点名唯一那位审读员')
  assert.match(skill, /send_message/, '复核必须走 send_message 复用原读者')
  assert.match(skill, /run_in_background: false/, '前台调用会退化成一次性会话，技能必须明令不要传')
  // 精简版不读完整版的面板：那份规则文件对应的是本模式没有的五个角色工具。
  assert.doesNotMatch(skill, /references\/review-panel\.md/)
  assert.match(skill, /没有额外的派发面板要读/, '精简流程必须自足，否则模型会去找不存在的面板文件')
  assert.match(skill, /不超过 2 位/, '派发上限要与本模式实际装的东西一致（一位审读员 + 通用出口）')
  // 契约里提到完整版技能/面板的段落必须被显式作废，否则精简会话会跟着指针去读没有挂载的文件。
  assert.match(skill, /契约正文里提到 `short-story` 技能/, '共享契约指向完整版文档，精简技能必须作废那些指针')
  // 盲目与复核是二选一：两位名额里没有第三位。
  assert.match(skill, /最终盲读另起一位全新读者/, '重写后要能排除旧报告影响，否则这条能力静默消失')
  assert.match(skill, /list_agents/, '上下文压缩后要能找回 childId')
  // 通用出口不是审读替代品（它没有信息边界，也没有报告格式）。
  assert.match(skill, /不要拿它顶替审读员/)
})

test('the lite preset deliberately drops the five role tools, the web and the goal toolkit', async () => {
  const block = presetBlock(await read(COMPOSITION))
  // 五位角色化审读员只住在完整版那一层：精简层里一个都不许出现。
  assert.doesNotMatch(block, /subagent_review_b\d/, '精简层没有 subagent_review_b1..b5')
  assert.doesNotMatch(block, /tool-subagent-review-b\d/)
  assert.doesNotMatch(block, /tool-(web|goal)\b/, 'tool-web / tool-goal 各带 2–3 个 schema，精简层不带')
  // `command-goal` 也必须在场外：它只注册 `/goal`，而读/建/标记目标的工具都在 tool-goal 里，
  // 半个功能会把目标置为 armed 却收不回来（round driver 会一直催"读当前目标并标记完成"）。
  assert.doesNotMatch(block, /- id: command-goal$/, '只留 /goal 命令而不留目标工具，是本层刻意避免的坑')
  assert.doesNotMatch(block, /provider:\s*fork/)
  assert.doesNotMatch(block, /one-shot/)
  // loader 不对 `name` 插值：`name: !!js` 会变成对象、整行报错。
  assert.doesNotMatch(block, /^\s*name:\s*!!js/m, '行的 name 不能写 !!js')
  assert.doesNotMatch(block, /^\s*name:\s*\.{1,2}[\\/]/m, '相对路径会按 profile 目录解析')
  assert.doesNotMatch(block, /^\s*name:\s*[\\/]/m, '绝对路径同理')
  assert.doesNotMatch(block, /^\s*name:\s*[A-Za-z][A-Za-z0-9+.-]*:\/\//m, '行的 name 不能是 URL')
  assert.doesNotMatch(block, /file:\/\//)
  assert.doesNotMatch(block, /[A-Za-z]:[\\/]/, 'patch 里不该出现盘符路径')
})

test('the merged reviewer keeps the judging rules the five roles each carried', async () => {
  const persona = await read('skills-lite/references/reviewer-merged.md')
  // 合并读者不是"把五份文件删到一份"：完整版靠分工写下的判据必须逐类留在人设里，
  // 否则合并的代价会变成静默漏检（每条都对应完整版某一位角色文件里的一句话）。
  assert.match(persona, /契约是尺子|契约只决定 ④ 这一节的判断尺度/, '契约不能拿来预判冷读证据（B1 的边界）')
  assert.match(persona, /人物卡、节拍与设定是\*\*参考\*\*/, 'B2：正文与草案不同不等于错')
  assert.match(persona, /不要为小幅偏差要求机械增删/, 'B2：字数档位是参考')
  assert.match(persona, /可合理省略的过程/, 'B5：过程缺失分三类，不为可省略的普通动作要求补写')
  assert.match(persona, /无需提交逐句状态表/, 'B5：报告不得退化成状态表')
  assert.match(persona, /值得保留的地方/, 'B1/B4：报告不只做减法，要保留有效表达')
  assert.match(persona, /这一节不报理解障碍|不报节奏与场景停留/, '五个维度的取证边界要各自写明')
  assert.match(persona, /证据优先于覆盖/, '五节 3 条 + 上限会把短引压没，报告规则必须先保证据')
  assert.match(persona, /最终盲读/, '重写后的盲读路径要写进复核规则')
})

test('the lite preset keeps every row this writing mode still depends on', async () => {
  const block = presetBlock(await read(COMPOSITION))
  // 直接子行的清单本身就是契约：增删都是有意为之，谁改谁要在这里说清楚。
  const childIds = [...block.matchAll(/^ {10}- id: (\S+)$/gm)].map((match) => match[1])
  assert.deepEqual(childIds, REQUIRED_ROWS, '精简层的子插件清单发生了变化')
  // compaction 的孩子在下一层：没有裁剪器，长稿会把上下文吃满（与完整版同一套）。
  const groupIds = [...block.matchAll(/^ {14}- id: (\S+)$/gm)].map((match) => match[1])
  assert.deepEqual(groupIds, REQUIRED_GROUP_ROWS, 'compaction 组的孩子变了')
  const storyTools = row(block, 'story-tools')
  assert.match(storyTools, /^\s*name: dsh-story-mode$/m, '本包自己的插件行写裸包名，不写路径')
  assert.match(storyTools, /sceneDriftPercent: 15/)
  assert.match(storyTools, /repeatThreshold: 3/)
  // `skill-filesystem` 的 customSkillDirs 是必填项之一，`sampleOverCapGlobResults` 也是。
  assert.match(row(block, 'tool-fs-search'), /sampleOverCapGlobResults: false/)
  assert.match(row(block, 'agent-instructions'), /maxBytes: 8192/, 'AGENTS.md 每轮注入，精简层收紧上限')
})
