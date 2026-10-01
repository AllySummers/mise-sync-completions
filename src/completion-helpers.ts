import { join } from 'node:path';
import type { MiseToolInfo, Shell } from './shared.ts';

/** `name@version` for a discovered install, so generation runs that exact version. */
export const miseToolSpec = (tool: MiseToolInfo): string =>
  tool.install_path && tool.version ? `${tool.name}@${tool.version}` : tool.name;

export const runMiseCommand = async (
  miseTool: string | MiseToolInfo,
  command: string[],
): Promise<string | null> => {
  const spec = typeof miseTool === 'string' ? miseTool : miseToolSpec(miseTool);
  const result = await new Deno.Command('mise', {
    args: ['x', spec, '--', ...command],
    stdout: 'piped',
    stderr: 'null',
    // `mise x` has no --global flag; `/` has no project config above it, so only global config applies.
    cwd: '/',
  }).output();
  const output = new TextDecoder().decode(result.stdout);
  return result.success && output.trim() ? output : null;
};

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
