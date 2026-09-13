import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

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
