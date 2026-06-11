export type ShellCommands = Partial<Record<Shell, string>>;

export interface RegistryMetadata {
  /** Generate this completion when another mise tool is installed (e.g. uvx from uv). */
  providedBy?: string;
  /** Other mise tool names that use this registry entry. */
  aliases?: string[];
}

export type ShellCommandsEntry = ShellCommands & RegistryMetadata;

export type CompletionSource = 'command' | 'http' | 'bundled';

/** Returns completion file contents directly (not a shell command to run). */
export type RegistryHandler = (
  tool: MiseToolInfo,
  shell: Shell,
) => string | null | Promise<string | null>;

export interface RegistryHandlerEntry extends RegistryMetadata {
  source?: Exclude<CompletionSource, 'command'>;
  handler: RegistryHandler;
}

/** Generates shell commands to run for each shell. */
export type CommandFn = (tool: MiseToolInfo) => ShellCommands;

export type RegistryEntry =
  | ShellCommandsEntry
  | CommandFn
  | RegistryHandlerEntry;

export interface RegistryModule {
  tools: Record<string, RegistryEntry>;
}

export interface CLIOptions {
  statePath: string;
  /** Resolved directory to write completions for the active shell. */
  completionsPath: string;
  registryPath: string;
  force?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  shell: Shell;
  enableHttpCompletions?: boolean;
  enableBundledCompletions?: boolean;
  disabledTools?: string[];
}

export interface MiseToolInfo {
  name: string;
  version: string;
  requested_version?: string;
  install_path: string;
  source?: { type: string; path: string };
  installed: boolean;
  active: boolean;
}

export const VALID_SHELLS = ['zsh', 'bash', 'fish'] as const;
export type Shell = (typeof VALID_SHELLS)[number];

export const isRegistryHandlerEntry = (
  entry: RegistryEntry,
): entry is RegistryHandlerEntry =>
  typeof entry === 'object' &&
  entry !== null &&
  'handler' in entry &&
  typeof entry.handler === 'function';
