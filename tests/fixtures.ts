import { dirname, join } from 'node:path';

export const ARTIFACT = 'tool-aarch64-apple-darwin.tar.gz';
export const DARWIN_ARM = { os: 'darwin', arch: 'aarch64' };

type Files = Record<string, string>;

export interface InstallFixture {
  bins?: (string | { path: string; name: string })[];
  resources?: Record<string, unknown>[];
  artifacts?: Record<string, unknown>[];
  /** `.mise-packslip-artifact` contents; `null` leaves the file out. Defaults to the first artifact. */
  selected?: string | null;
  /** Raw `.mise-packslip.json`, replacing the generated statement. */
  statement?: string;
  assets?: Files;
  archive?: Files;
  repo?: Files;
}

const putFiles = async (base: string, files: Files) => {
  for (const [rel, content] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(base, rel)), { recursive: true });
    await Deno.writeTextFile(join(base, rel), content);
  }
};

/** A packslip install laid out as mise v2026.9.17 leaves it. */
export const writeInstall = async (dir: string, fx: InstallFixture = {}): Promise<string> => {
  await Deno.mkdir(dir, { recursive: true });
  const artifacts = fx.artifacts ?? [
    { name: ARTIFACT, os: 'darwin', arch: 'aarch64', format: 'tar.gz', bin: fx.bins ?? ['tool'] },
  ];
  const statement = fx.statement ?? JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [],
    predicateType: 'https://packslip.dev/release/v1',
    predicate: {
      project: 'github.com/example/tool',
      version: '1.0.0',
      artifacts,
      resources: fx.resources ?? [],
    },
  });
  await Deno.writeTextFile(join(dir, '.mise-packslip.json'), statement);
  const selected = fx.selected === undefined ? String(artifacts[0]?.name) : fx.selected;
  if (selected !== null) {
    await Deno.writeTextFile(join(dir, '.mise-packslip-artifact'), selected);
  }
  await putFiles(join(dir, '.mise-packslip', 'assets'), fx.assets ?? {});
  await putFiles(dir, fx.archive ?? {});
  await putFiles(join(dir, '.mise-packslip', 'repo'), fx.repo ?? {});
  return dir;
};

/** Static asset completions for one executable in every shell, as hk and usage ship them. */
export const assetCompletions = (bin: string, withBin = false) => ({
  resources: ['bash', 'zsh', 'fish'].map((shell) => ({
    kind: 'completion',
    shell,
    ...(withBin ? { bin } : {}),
    asset: `${bin}.${shell}`,
  })),
  assets: Object.fromEntries(
    ['bash', 'zsh', 'fish'].map((shell) => [`${bin}.${shell}`, `# native ${bin} ${shell}\n`]),
  ),
});
