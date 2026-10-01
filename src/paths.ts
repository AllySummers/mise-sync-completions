import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Shell } from './shared.ts';

export const expandHome = (path: string): string =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

export const dataHome = (): string =>
  Deno.env.get('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share');

/** bash-completion's user directory: the first `BASH_COMPLETION_USER_DIR` entry, else XDG. */
const bashCompletionUserDir = (): string =>
  Deno.env.get('BASH_COMPLETION_USER_DIR')?.split(':').find(Boolean) ??
    join(dataHome(), 'bash-completion');

export const defaultCompletionsPath = (shell: Shell): string =>
  shell === 'bash'
    ? join(bashCompletionUserDir(), 'completions')
    : join(dataHome(), 'mise-completions', shell);
