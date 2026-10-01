import { join } from 'node:path';
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
 */
export const runMise = async (args: string[]): Promise<string | null> => {
  try {
    const result = await new Deno.Command('mise', {
      args,
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

const matchGlobPrefix = (name: string, pattern: string): boolean => {
  const prefix = pattern.replace(/\*.*$/, '');
  return name.startsWith(prefix);
};

const findPlatformDir = async (
  installPath: string,
  dirPattern: string,
): Promise<string | null> => {
  for await (const entry of Deno.readDir(installPath)) {
    if (entry.isDirectory && matchGlobPrefix(entry.name, dirPattern)) {
      return join(installPath, entry.name);
    }
  }
  return null;
};

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

export const readBundledCompletion = async (
  installPath: string,
  platformDirPattern: string,
  subdir: string,
  filenames: Record<Shell, string>,
  shell: Shell,
): Promise<string | null> => {
  const platformDir = await findPlatformDir(installPath, platformDirPattern);
  if (!platformDir) {
    return null;
  }
  try {
    return await Deno.readTextFile(join(platformDir, subdir, filenames[shell]));
  } catch {
    return null;
  }
};
