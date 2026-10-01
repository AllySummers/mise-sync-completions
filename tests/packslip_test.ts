import assert from 'node:assert/strict';
import { join } from 'node:path';
import { inspectPackslip } from '../src/packslip.ts';
import { ARTIFACT, assetCompletions, DARWIN_ARM, writeInstall } from './fixtures.ts';

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Deno.makeTempDir({ prefix: 'msc-packslip-' });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test('static asset completions are native for every shell', async () => {
  await withDir(async (dir) => {
    const install = await writeInstall(join(dir, 'hk'), {
      bins: ['hk'],
      ...assetCompletions('hk'),
    });
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const result = await inspectPackslip(install, 'hk', shell, DARWIN_ARM);
      assert.equal(result.outcome, 'native', shell);
      assert.ok(result.outcome === 'native' && !result.generator);
      assert.ok(result.outcome === 'native' && result.path?.endsWith(`hk.${shell}`));
    }
  });
});

Deno.test('each executable of a multi-binary release resolves its own resources', async () => {
  await withDir(async (dir) => {
    const install = await writeInstall(join(dir, 'aube'), {
      bins: ['aube', 'aubr', 'aubx'],
      resources: [
        ...assetCompletions('aube', true).resources,
        { kind: 'completion', shell: 'zsh', bin: 'aube', os: 'darwin', asset: 'aube-darwin.zsh' },
        { kind: 'completion', shell: 'zsh', bin: 'aubr', asset: 'aubr.zsh' },
      ],
      assets: {
        ...assetCompletions('aube', true).assets,
        'aube-darwin.zsh': '# darwin\n',
        'aubr.zsh': '# aubr\n',
      },
    });
    const aube = await inspectPackslip(install, 'aube', 'zsh', DARWIN_ARM);
    assert.ok(aube.outcome === 'native' && aube.path?.endsWith('aube-darwin.zsh'));
    const aubr = await inspectPackslip(install, 'aubr', 'zsh', DARWIN_ARM);
    assert.ok(aubr.outcome === 'native' && aubr.path?.endsWith('aubr.zsh'));
    assert.equal((await inspectPackslip(install, 'aubr', 'bash', DARWIN_ARM)).outcome, 'legacy');
    assert.equal((await inspectPackslip(install, 'aubx', 'zsh', DARWIN_ARM)).outcome, 'legacy');
  });
});

Deno.test('man pages, skills, and other shells are not completions', async () => {
  await withDir(async (dir) => {
    const install = await writeInstall(join(dir, 'usage'), {
      bins: ['usage'],
      resources: [
        { kind: 'man', archive: 'usage.1' },
        { kind: 'skill', name: 'usage', repo: 'skills/usage' },
        { kind: 'completion', shell: 'bash', asset: 'usage.bash' },
      ],
      archive: { 'usage.1': '.TH usage\n' },
      assets: { 'usage.bash': '# bash\n' },
    });
    const zsh = await inspectPackslip(install, 'usage', 'zsh', DARWIN_ARM);
    assert.equal(zsh.outcome, 'legacy');
    assert.equal((await inspectPackslip(install, 'usage', 'bash', DARWIN_ARM)).outcome, 'native');
  });
});

Deno.test('an install without a statement uses the registry fallback', async () => {
  await withDir(async (dir) => {
    const result = await inspectPackslip(dir, 'deno', 'zsh', DARWIN_ARM);
    assert.deepEqual(result, {
      outcome: 'legacy',
      command: 'deno',
      reason: 'not installed from a packslip',
    });
    assert.equal((await inspectPackslip('', 'mise', 'zsh', DARWIN_ARM)).outcome, 'legacy');
  });
});

Deno.test('malformed or unfamiliar metadata needs attention, never legacy', async () => {
  await withDir(async (dir) => {
    const cases = {
      'not json': '{',
      'other predicate': JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://packslip.dev/release/v2',
        predicate: {},
      }),
      'no artifacts': JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://packslip.dev/release/v1',
        predicate: { artifacts: [] },
      }),
    };
    for (const [name, statement] of Object.entries(cases)) {
      const install = await writeInstall(join(dir, name), { statement, selected: null });
      const result = await inspectPackslip(install, 'tool', 'zsh', DARWIN_ARM);
      assert.equal(result.outcome, 'needs-attention', name);
    }
  });
});

Deno.test('a declared but missing resource needs attention', async () => {
  await withDir(async (dir) => {
    const { resources } = assetCompletions('tool');
    const install = await writeInstall(join(dir, 'tool'), { resources });
    const result = await inspectPackslip(install, 'tool', 'zsh', DARWIN_ARM);
    assert.equal(result.outcome, 'needs-attention');
    assert.match(result.reason, /none of its files are in the install/);
  });
});

Deno.test('cli-spec: usage is native, other formats need attention', async () => {
  await withDir(async (dir) => {
    const spec = (format: string) => ({
      resources: [{ kind: 'cli-spec', bin: 'tool', format, asset: `tool.${format}` }],
      assets: { [`tool.${format}`]: 'spec\n' },
    });
    const usage = await inspectPackslip(
      await writeInstall(join(dir, 'usage'), spec('usage')),
      'tool',
      'fish',
      DARWIN_ARM,
    );
    assert.ok(usage.outcome === 'native' && usage.source === 'spec' && !usage.generator);
    const other = await inspectPackslip(
      await writeInstall(join(dir, 'other'), spec('clap')),
      'tool',
      'fish',
      DARWIN_ARM,
    );
    assert.equal(other.outcome, 'needs-attention');
    assert.match(other.reason, /clap/);
  });
});

Deno.test('declared generators are native but flagged as not yet run', async () => {
  await withDir(async (dir) => {
    const exec = await writeInstall(join(dir, 'exec'), {
      resources: [{
        kind: 'completion',
        shells: ['zsh', 'bash'],
        exec: ['tool', 'complete', '{shell}'],
      }],
    });
    const zsh = await inspectPackslip(exec, 'tool', 'zsh', DARWIN_ARM);
    assert.ok(zsh.outcome === 'native' && zsh.source === 'exec' && zsh.generator);
    assert.equal((await inspectPackslip(exec, 'tool', 'fish', DARWIN_ARM)).outcome, 'legacy');

    const specExec = await writeInstall(join(dir, 'spec-exec'), {
      resources: [{ kind: 'cli-spec', bin: 'tool', format: 'usage', exec: ['tool', 'usage'] }],
    });
    const spec = await inspectPackslip(specExec, 'tool', 'zsh', DARWIN_ARM);
    assert.ok(spec.outcome === 'native' && spec.source === 'spec-exec' && spec.generator);
  });
});

Deno.test('static files win over generators; archive wins over asset', async () => {
  await withDir(async (dir) => {
    const install = await writeInstall(join(dir, 'tool'), {
      resources: [
        { kind: 'completion', shells: ['zsh'], exec: ['tool', 'complete', '{shell}'] },
        { kind: 'completion', shell: 'zsh', asset: 'tool.zsh' },
        { kind: 'completion', shell: 'zsh', archive: 'tool-1.0/share/zsh/_tool' },
      ],
      assets: { 'tool.zsh': '# asset\n' },
      archive: { 'share/zsh/_tool': '# archive, top-level directory stripped\n' },
    });
    const result = await inspectPackslip(install, 'tool', 'zsh', DARWIN_ARM);
    assert.ok(result.outcome === 'native' && result.path === join(install, 'share/zsh/_tool'));
  });
});

Deno.test('unsafe and escaping paths are not treated as present', async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'outside.zsh'), '# outside\n');
    const install = await writeInstall(join(dir, 'tool'), {
      resources: [
        { kind: 'completion', shell: 'zsh', archive: '../outside.zsh' },
        { kind: 'completion', shell: 'zsh', asset: 'link.zsh' },
      ],
    });
    await Deno.mkdir(join(install, '.mise-packslip', 'assets'), { recursive: true });
    await Deno.symlink(join(dir, 'outside.zsh'), join(install, '.mise-packslip/assets/link.zsh'));
    const result = await inspectPackslip(install, 'tool', 'zsh', DARWIN_ARM);
    assert.equal(result.outcome, 'needs-attention');
  });
});

Deno.test('resources follow platform scope and the most specific entry', async () => {
  await withDir(async (dir) => {
    const install = await writeInstall(join(dir, 'tool'), {
      resources: [
        { kind: 'completion', shell: 'bash', os: 'linux', asset: 'linux.bash' },
        { kind: 'completion', shell: 'zsh', asset: 'any.zsh' },
        { kind: 'completion', shell: 'zsh', artifact: ARTIFACT, asset: 'artifact.zsh' },
      ],
      assets: { 'linux.bash': '#\n', 'any.zsh': '#\n', 'artifact.zsh': '#\n' },
    });
    assert.equal((await inspectPackslip(install, 'tool', 'bash', DARWIN_ARM)).outcome, 'legacy');
    const zsh = await inspectPackslip(install, 'tool', 'zsh', DARWIN_ARM);
    assert.ok(zsh.outcome === 'native' && zsh.path?.endsWith('artifact.zsh'));
  });
});

Deno.test('the installed artifact is resolved before any resource is trusted', async () => {
  await withDir(async (dir) => {
    const linux = (libc: string) => ({
      name: `tool-${libc}.tar.gz`,
      os: 'linux',
      arch: 'x86_64',
      libc,
      format: 'tar.gz',
      bin: ['tool'],
    });
    const { resources, assets } = assetCompletions('tool');
    const host = { os: 'linux', arch: 'x86_64' };

    const ambiguous = await writeInstall(join(dir, 'ambiguous'), {
      artifacts: [linux('gnu'), linux('musl')],
      selected: null,
      resources,
      assets,
    });
    assert.equal(
      (await inspectPackslip(ambiguous, 'tool', 'zsh', host)).outcome,
      'needs-attention',
    );

    const recorded = await writeInstall(join(dir, 'recorded'), {
      artifacts: [linux('gnu'), linux('musl')],
      selected: 'tool-musl.tar.gz\n',
      resources,
      assets,
    });
    assert.equal((await inspectPackslip(recorded, 'tool', 'zsh', host)).outcome, 'native');

    const single = await writeInstall(join(dir, 'single'), { selected: null, resources, assets });
    assert.equal((await inspectPackslip(single, 'tool', 'zsh', DARWIN_ARM)).outcome, 'native');
  });
});

Deno.test('only executables of the installed artifact are handed off', async () => {
  await withDir(async (dir) => {
    const install = await writeInstall(join(dir, 'uv'), {
      bins: ['uv'],
      ...assetCompletions('uv'),
    });
    const uvx = await inspectPackslip(install, 'uvx', 'zsh', DARWIN_ARM);
    assert.equal(uvx.outcome, 'legacy');
    assert.match(uvx.reason, /no uvx executable/);
  });
});

Deno.test('executable names are normalized across bin forms and .exe', async () => {
  await withDir(async (dir) => {
    const windows = { os: 'windows', arch: 'x86_64' };
    const install = await writeInstall(join(dir, 'tool'), {
      artifacts: [{
        name: 'tool.zip',
        os: 'windows',
        arch: 'x86_64',
        format: 'zip',
        bin: ['bin/tool.exe', { path: 'bin/tool-cli.exe', name: 'tc' }],
      }],
      resources: [
        { kind: 'completion', shell: 'bash', bin: 'tool.exe', asset: 'tool.bash' },
        { kind: 'completion', shell: 'bash', bin: 'tc', asset: 'tc.bash' },
      ],
      assets: { 'tool.bash': '#\n', 'tc.bash': '#\n' },
    });
    const tool = await inspectPackslip(install, 'tool', 'bash', windows);
    assert.ok(tool.outcome === 'native' && tool.path?.endsWith('tool.bash'));
    const tc = await inspectPackslip(install, 'tc', 'bash', windows);
    assert.ok(tc.outcome === 'native' && tc.path?.endsWith('tc.bash'));
    assert.equal((await inspectPackslip(install, 'tool-cli', 'bash', windows)).outcome, 'legacy');
  });
});
