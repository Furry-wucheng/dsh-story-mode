import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

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
