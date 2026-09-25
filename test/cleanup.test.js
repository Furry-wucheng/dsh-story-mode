import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { doctorTool, renderDoctor, runDoctor } from '../lib/doctor.js'

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
/** 本包根目录：上面的 doctor 与下面拷贝出来那一份都以它为基准。 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('0.1.7 default preset lives in the profile patch: only that line is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-test-'))
  try {
    const dir = join(root, 'profiles', 'desktop')
    await mkdir(dir, { recursive: true })
    // 用户自己选的默认模式由 loader 写回 volatile 字段，实测落在这一层；
    // 顺便混进一条同名但属于别的行目的字段，验证我们只碰注册表那一条。
    const patch = [
      '# profile patch',
      '- id: agent-preset-registry',
      '  name: "@deepseek-ai/dsh-agent-preset-registry"',
      '  config:',
      '    default: standard',
      '    selectedDefault: short-story',
      '- id: some-other-row',
      '  config:',
      '    selectedDefault: short-story',
      '',
    ].join('\n')
    await writeFile(join(dir, 'cordis.patch.yml'), patch)
    const run = (command) => spawnSync(process.execPath, [cli, command, '--dsh-home', root], { encoding: 'utf8' })

    const checked = run('check')
    assert.equal(checked.status, 1, checked.stderr)
    assert.match(checked.stdout, /cordis\.patch\.yml 第 6 行：selectedDefault = short-story/)
    assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), patch, '--check 不改文件')

    const cleaned = run('cleanup')
    assert.equal(cleaned.status, 0, cleaned.stderr)
    assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), [
      '# profile patch',
      '- id: agent-preset-registry',
      '  name: "@deepseek-ai/dsh-agent-preset-registry"',
      '  config:',
      '    default: standard',
      '- id: some-other-row',
      '  config:',
      '    selectedDefault: short-story',
      '',
    ].join('\n'), '只删注册表条目里那一行，其余逐字保留')
    assert.equal(run('check').status, 0)
    assert.equal(run('cleanup').status, 0)
  } finally {
    const target = await realpath(root)
    const parent = await realpath(resolve(tmpdir()))
    assert.ok(target.startsWith(parent + sep), 'cleanup restricted to this test temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})

test('a profile patch that pins the deployment default keeps the required field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-test-'))
  try {
    const dir = join(root, 'profiles', 'web')
    await mkdir(dir, { recursive: true })
    // `default` 是必填字段：不能像 selectedDefault 那样删行，只能把值换回 standard。
    const patch = [
      '- id: agent-preset-registry',
      '  config:',
      '    default: short-story',
      '',
    ].join('\n')
    await writeFile(join(dir, 'cordis.patch.yml'), patch)
    const cleaned = spawnSync(process.execPath, [cli, 'cleanup', '--dsh-home', root], { encoding: 'utf8' })
    assert.equal(cleaned.status, 0, cleaned.stderr)
    assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), [
      '- id: agent-preset-registry',
      '  config:',
      '    default: standard',
      '',
    ].join('\n'))
  } finally {
    const target = await realpath(root)
    const parent = await realpath(resolve(tmpdir()))
    assert.ok(target.startsWith(parent + sep), 'cleanup restricted to this test temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})

test('the lite preset is cleared too: selecting it as default cannot strand the profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-test-'))
  try {
    const dir = join(root, 'profiles', 'desktop')
    await mkdir(dir, { recursive: true })
    // 包现在声明两个 preset，用户可能在模式选择器里把**精简版**设成默认。
    // 只认完整版的话，卸载后同样以 agent-preset/not-found 失败——那是本包唯一
    // 不可恢复的失败形态，所以两个 id 都要认，而且报告里要说清是哪一个。
    const patch = [
      '- id: agent-preset-registry',
      '  config:',
      '    default: standard',
      '    selectedDefault: short-story-lite',
      '',
    ].join('\n')
    await writeFile(join(dir, 'cordis.patch.yml'), patch)
    const run = (command) => spawnSync(process.execPath, [cli, command, '--dsh-home', root], { encoding: 'utf8' })

    const checked = run('check')
    assert.equal(checked.status, 1, checked.stderr)
    assert.match(checked.stdout, /selectedDefault = short-story-lite/)
    assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), patch, '--check 不改文件')

    const cleaned = run('cleanup')
    assert.equal(cleaned.status, 0, cleaned.stderr)
    assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), [
      '- id: agent-preset-registry',
      '  config:',
      '    default: standard',
      '',
    ].join('\n'))
    assert.equal(run('check').status, 0)
  } finally {
    const target = await realpath(root)
    const parent = await realpath(resolve(tmpdir()))
    assert.ok(target.startsWith(parent + sep), 'cleanup restricted to this test temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})

test('a default that names neither writing preset is left alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-test-'))
  try {
    const dir = join(root, 'profiles', 'desktop')
    await mkdir(dir, { recursive: true })
    const patch = [
      '- id: agent-preset-registry',
      '  config:',
      '    selectedDefault: standard',
      '',
    ].join('\n')
    await writeFile(join(dir, 'cordis.patch.yml'), patch)
    const run = (command) => spawnSync(process.execPath, [cli, command, '--dsh-home', root], { encoding: 'utf8' })

    const checked = run('check')
    assert.equal(checked.status, 0, checked.stderr)
    assert.doesNotMatch(checked.stdout, /待清理/, '别人的默认模式不该被报成本包的待清理项')
    assert.equal(run('cleanup').status, 0)
    assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), patch, '别人的默认模式一个字都不动')
  } finally {
    const target = await realpath(root)
    const parent = await realpath(resolve(tmpdir()))
    assert.ok(target.startsWith(parent + sep), 'cleanup restricted to this test temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})

test('default-only uninstall warning fails check; cleanup preserves foreign files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-test-'))
  try {
    const settings = 'agent-presets:\n  default: short-story\nother-setting: retained\n'
    await writeFile(join(root, 'settings.yaml'), settings)
    const foreign = join(root, '.agent-presets', 'short-story')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'agent.cordis.yml'), 'user content')
    const run = (command) => spawnSync(process.execPath, [cli, command, '--dsh-home', root], { encoding: 'utf8' })

    const checked = run('check')
    assert.equal(checked.status, 1, checked.stderr)
    assert.match(checked.stdout, /默认预设指向 short-story/)
    assert.doesNotMatch(checked.stdout, /就位/)
    assert.equal(await readFile(join(root, 'settings.yaml'), 'utf8'), settings)

    const cleaned = run('cleanup')
    assert.equal(cleaned.status, 0, cleaned.stderr)
    assert.equal(await readFile(join(root, 'settings.yaml'), 'utf8'), 'other-setting: retained\n')
    assert.equal(await readFile(join(foreign, 'agent.cordis.yml'), 'utf8'), 'user content')
    assert.equal(run('check').status, 0)
    assert.equal(run('cleanup').status, 0)
  } finally {
    const target = await realpath(root)
    const parent = await realpath(resolve(tmpdir()))
    assert.ok(target.startsWith(parent + sep), 'cleanup restricted to this test temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})

// ── lib/doctor.js 的双 preset 回归 ───────────────────────────────────────────
//
// 自检自己的契约测试住在 test/preset-contract.test.js（那个文件是冻结的），所以这
// 几条放在这里。每一条钉住一个**静默误判**：只查一层 patch、把另一个 preset 的读数
// 当成本模式的、以及默认值只认一个 id——三种都能让报告在真出故障时说"一切正常"。

/** 造一个"包已装进 profile"的临时 DSH 主目录（自检的静态判据全靠这些文件）。 */
async function doctorHome(registry = null) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-story-doctor-'))
  const profile = join(root, 'profiles', 'desktop')
  const installed = join(profile, 'node_modules', 'dsh-story-mode')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), '{"name":"dsh-story-mode"}')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-story-mode'] } } }))
  if (registry !== null) await writeFile(join(profile, 'cordis.patch.yml'), registry)
  return root
}

/** 注册表条目：`default` 是部署默认值，`selectedDefault` 是用户自己选的那一个。 */
function registryRow(fields) {
  return ['- id: agent-preset-registry', '  config:', ...fields.map((line) => `    ${line}`), ''].join('\n')
}

/** 在临时 home 里跑一次自检：给了 ctx 就顺带做活体检查。 */
async function doctorReport(root, { ctx, agentCtx } = {}) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    return renderDoctor(await runDoctor(ctx, agentCtx))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/** 假的 agentPresets 服务：两个模式都挂起来（默认仍留给 `standard`）。 */
function fakeAgentPresets(agentCtx, { liteSkills = ['short-story-lite', 'writing-style-contract'], liteIsDefault = false } = {}) {
  const skills = {
    'short-story': ['short-story', 'writing-style-contract'],
    'short-story-lite': liteSkills,
  }
  return {
    service: {
      async remoteExportList() {
        return {
          presets: [
            { id: 'standard', isDefault: !liteIsDefault },
            { id: 'short-story', isDefault: false, name: '短篇小说模式', order: 5 },
            { id: 'short-story-lite', isDefault: liteIsDefault, name: '短篇小说模式（精简）', order: 6 },
          ],
        }
      },
      async compositionInventory() {
        return [
          { id: 'short-story', isDefault: false, rows: Array.from({ length: 24 }, () => ({ fiberState: 2 })) },
          { id: 'short-story-lite', isDefault: liteIsDefault, rows: Array.from({ length: 19 }, () => ({ fiberState: 2 })) },
        ]
      },
      async acquireScope(id) {
        return { key: `scope:${id}`, [Symbol.asyncDispose]: async () => {} }
      },
      // 注册表真正的判据：只有**真 agent 的 ctx** 能回答"我在哪个 preset 里"。
      composedPreset(ctx) {
        return ctx === agentCtx ? 'short-story-lite' : undefined
      },
    },
    skills,
  }
}

/** 只提供自检用得到的那三个服务的 ctx。 */
function fakeCtx({ service, skills }) {
  return {
    get(name) {
      if (name === 'agentPresets') return service
      if (name === 'skills') {
        return { list: async ({ scope }) => (skills[scope.slice('scope:'.length)] ?? []).map((skill) => ({ name: skill })) }
      }
      if (name === 'tools') {
        return { schemas: () => ['story_wordcount', 'story_lint', 'story_bible', 'story_doctor'].map((name) => ({ name })) }
      }
      return undefined
    },
  }
}

test('the doctor checks both patch layers, not just the full preset', async () => {
  const root = await doctorHome()
  try {
    const report = await doctorReport(root)
    // 两层各自的表都在：只查一层时，另一层挂不上，报告照样会说"一切正常"。
    assert.match(report, /\| 插入了 `preset-short-story` 行 \| 是 \|/)
    assert.match(report, /\| 插入了 `preset-short-story-lite` 行 \| 是 \|/)
    assert.match(report, /\| 声明了 order（本层应为 6） \| 是 \|/)
    assert.match(report, /技能根指向包内 \| 是（skills-lite、skills\/writing-style-contract） \|/)
    assert.match(report, /合并审读员人设 skills-lite\/references\/reviewer-merged\.md \| 是 \|/)
    assert.match(report, /有意不装的行（tool-web、tool-goal） \| 是（未出现） \|/)
    assert.doesNotMatch(report, /有 \d+ 处需要处理/)
    assert.match(report, /静态检查全部通过/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the doctor does not call a dangling lite default uninstall-safe', async () => {
  // `default: standard` 写在前面、`selectedDefault: short-story-lite` 写在后面：
  // 注册表读的是 `selectedDefault ?? default`，所以只认第一个字段会漏掉真正会悬空的 id。
  const selected = await doctorHome(registryRow(['default: standard', 'selectedDefault: short-story-lite']))
  try {
    const report = await doctorReport(selected)
    assert.match(report, /你的默认模式就是本模式（`short-story-lite`）/)
    assert.match(report, /默认预设（`short-story-lite`）指向本模式，卸载前必须先清理/)
    assert.doesNotMatch(report, /卸载安全/)
  } finally {
    await rm(selected, { recursive: true, force: true })
  }

  // 部署默认值被钉在精简版上：同样是卸载后无人可救的悬空 id。
  const pinned = await doctorHome(registryRow(['default: short-story-lite']))
  try {
    const report = await doctorReport(pinned)
    assert.match(report, /你的默认模式就是本模式（`short-story-lite`）/)
    assert.match(report, /默认预设（`short-story-lite`）指向本模式/)
  } finally {
    await rm(pinned, { recursive: true, force: true })
  }

  // 别人的 id：报"安全"，且不许冒出待处理项。
  const foreign = await doctorHome(registryRow(['selectedDefault: standard']))
  try {
    const report = await doctorReport(foreign)
    assert.match(report, /不是本模式，卸载安全/)
    assert.doesNotMatch(report, /指向本模式/)
    assert.doesNotMatch(report, /有 \d+ 处需要处理/)
  } finally {
    await rm(foreign, { recursive: true, force: true })
  }
})

test('a package without the lite layer still renders a report instead of throwing', async () => {
  // 整层 patch 不在，正是最该被看清的那种故障——渲染器不能在它上面抛错。
  // 直接改仓库里的文件当然不行（那是被测对象），所以复制一份**不含**
  // `cordis.lite.patch.yml` 的包，跑它自己那份 doctor。
  const copy = await mkdtemp(join(tmpdir(), 'dsh-story-nolite-'))
  try {
    for (const item of ['lib', 'cordis.patch.yml', 'package.json']) {
      await cp(join(packageRoot, item), join(copy, item), { recursive: true })
    }
    const home = join(copy, 'fakehome')
    const profile = join(home, 'profiles', 'desktop')
    await mkdir(join(profile, 'node_modules', 'dsh-story-mode'), { recursive: true })
    await writeFile(join(profile, 'node_modules', 'dsh-story-mode', 'package.json'), '{"name":"dsh-story-mode"}')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-story-mode'] } } }))

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let report
    try {
      const doctor = await import(pathToFileURL(join(copy, 'lib', 'doctor.js')).href)
      report = doctor.renderDoctor(await doctor.runDoctor())
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
    // 完整版那一层照旧逐项查（拷贝里它在），精简版那一层点名说"没人声明"。
    assert.match(report, /\| 插入了 `preset-short-story` 行 \| 是 \|/)
    assert.match(report, /缺少 cordis\.lite\.patch\.yml：短篇小说模式（精简）无人声明/)
    assert.match(report, /\| `cordis\.lite\.patch\.yml` 存在 \| \*\*否\*\* \|/)
    assert.match(report, /\| 组合必需行（18 行） \| \*\*否/)
    assert.doesNotMatch(report, /一切正常/)
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test('the live probe reports each preset by id and names the one the tool runs in', async () => {
  const agentCtx = {}
  const { service, skills } = fakeAgentPresets(agentCtx)
  const root = await doctorHome()
  try {
    const report = await doctorReport(root, { ctx: fakeCtx({ service, skills }), agentCtx })
    // 两个 preset 各一份读数：一个装起来不代表另一个也装起来了。
    assert.match(report, /（活体）roster 里有 short-story \| 是 \|/)
    assert.match(report, /（活体）roster 里有 short-story-lite \| 是 \|/)
    assert.match(report, /（活体）short-story-lite 作用域里的技能 \| 是 —— short-story-lite、writing-style-contract \|/)
    assert.match(report, /（活体）short-story-lite 组合行数 \/ 已激活 \| 19 \/ 19 \|/)
    // 当前所在模式由注册表的 composedPreset(agent.ctx) 判定，不是拿完整版顶替。
    assert.match(report, /（活体）本工具当前所在模式 \| `short-story-lite`/)
    assert.match(report, /（活体）当前默认模式 \| 不是本包这两个模式 \|/)
    assert.match(report, /一切正常/)

    // 同一条链路的入口是**工具调用**：`exec.agent.ctx` 必须一路传到 composedPreset。
    // 少传这个参数（`run()` 不接 exec）时报告不报错，只会永远写"未能判定"——所以钉住它。
    const tool = doctorTool(fakeCtx({ service, skills }))
    const called = await tool.execute({}, { agent: { ctx: agentCtx } })
    assert.match(called.text, /（活体）本工具当前所在模式 \| `short-story-lite`/)
    const orphan = await tool.execute({}, { signal: undefined })
    assert.match(orphan.text, /（活体）本工具当前所在模式 \| \*\*未能判定\*\*/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  // 活体说精简版是默认时，卸载警告要按**它**的名字说（这是唯一一处不可恢复的故障）。
  const asDefault = fakeAgentPresets(agentCtx, { liteIsDefault: true })
  const defaultRoot = await doctorHome()
  try {
    const report = await doctorReport(defaultRoot, { ctx: fakeCtx(asDefault), agentCtx })
    assert.match(report, /（活体）roster 里有 short-story-lite \| 是 —— \*\*默认\*\* \|/)
    assert.match(report, /你的默认模式就是本模式（`short-story-lite`）/)
    assert.match(report, /默认预设（`short-story-lite`）指向本模式，卸载前必须先清理/)
  } finally {
    await rm(defaultRoot, { recursive: true, force: true })
  }

  // 精简版那一层技能不齐时，说的必须是**精简版**：旧版会把完整版的读数当成
  // "本模式"的健康状况，于是这句话永远不会出现。
  const partial = fakeAgentPresets(agentCtx, { liteSkills: ['writing-style-contract'] })
  const partialRoot = await doctorHome()
  try {
    const report = await doctorReport(partialRoot, { ctx: fakeCtx(partial), agentCtx })
    assert.match(report, /运行时 short-story-lite 作用域里技能不齐/)
    assert.doesNotMatch(report, /本作用域里技能不齐/)
    assert.doesNotMatch(report, /一切正常/)
  } finally {
    await rm(partialRoot, { recursive: true, force: true })
  }

  // 判不出当前所在时如实写"未能判定"，并且仍然逐个列出两个模式，不猜。
  const undeterminedRoot = await doctorHome()
  try {
    const report = await doctorReport(undeterminedRoot, { ctx: fakeCtx({ service, skills }) })
    assert.match(report, /（活体）本工具当前所在模式 \| \*\*未能判定\*\* —— 本次调用没有 agent ctx/)
    assert.match(report, /（活体）roster 里有 short-story-lite \| 是/)
  } finally {
    await rm(undeterminedRoot, { recursive: true, force: true })
  }
})
