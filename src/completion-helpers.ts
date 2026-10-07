import { expandGlob } from '@std/fs';
import { sep } from 'node:path';
import type { MiseToolInfo, Shell } from './shared.ts';

/** `tool@version` for a discovered install, so generation runs that exact version. */
export const miseToolSpec = (tool: MiseToolInfo): string => {
  const name = tool.provider ?? tool.name;
  return tool.install_path && tool.version ? `${name}@${tool.version}` : name;
};

/**
 * Runs `mise` and returns its stdout, or `null` if it failed or printed nothing. The working
 * directory is `/` because mise resolves versions from the project config above the cwd, and
 * `mise x`/`mise completion` have no global-only mode: `/` has no config above it, so only global
 * config applies. Never throws.
 *
 * Hooks are disabled for every call: `mise x` can fire a `postinstall` hook (e.g. for aube-based
 * npm installs) even for an installed tool, and that hook typically runs this task again, which
 * would then wait on the state lock this run holds. This is the only place mise is spawned.
 */
export const runMise = async (args: string[]): Promise<string | null> => {
  try {
    const result = await new Deno.Command('mise', {
      args,
      env: { MISE_NO_HOOKS: '1' },
      stdout: 'piped',
      stderr: 'null',
      cwd: '/',
    }).output();
    const out = new TextDecoder().decode(result.stdout);
    return result.success && out.trim() ? out : null;
  } catch {
    return null;
  }
};

export const runMiseCommand = (
  miseTool: string | MiseToolInfo,
  command: string[],
): Promise<string | null> =>
  runMise([
    'x',
    typeof miseTool === 'string' ? miseTool : miseToolSpec(miseTool),
    '--',
    ...command,
  ]);

export const fetchHttpCompletion = async (
  urls: Record<Shell, string>,
  shell: Shell,
): Promise<string | null> => {
  const res = await fetch(urls[shell]);
  return res.ok ? await res.text() : null;
};

export const normalizeVersionTag = (version: string): string =>
  version.replace(/^v/, '').split(/[+-\s]/)[0]!;

export const githubRawUrls = (
  repo: `${string}/${string}`,
  tag: string,
  paths: Record<Shell, string>,
): Record<Shell, string> => {
  const ref = normalizeVersionTag(tag);
  return Object.fromEntries(
    Object.entries(paths).map(([shell, path]) => [
      shell,
      `https://raw.githubusercontent.com/${repo}/${ref}/${path}`,
    ]),
  ) as Record<Shell, string>;
};

/**
 * Reads the completion file a tool ships in its download. `globs` maps each shell to a glob,
 * relative to the install path, such as `**\/completions/_tool`. `**` also matches zero
 * directories, so one pattern covers archives with and without a top-level directory. When
 * several files match, the shallowest wins.
 */
export const findBundledCompletion = async (
  installPath: string,
  globs: Partial<Record<Shell, string>>,
  shell: Shell,
): Promise<string | null> => {
  const glob = globs[shell];
  if (!installPath || !glob) {
    return null;
  }
  try {
    const paths: string[] = [];
    for await (const entry of expandGlob(glob, { root: installPath, includeDirs: false })) {
      paths.push(entry.path);
    }
    const [best] = paths.toSorted((a, b) =>
      a.split(sep).length - b.split(sep).length || (a < b ? -1 : 1)
    );
    return best ? await Deno.readTextFile(best) : null;
  } catch {
    return null;
  }
};
