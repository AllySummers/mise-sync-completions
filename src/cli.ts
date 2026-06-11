import { dirname, join } from 'node:path';
import { handlers as customHandlers } from './custom-completions.ts';
import { tools as builtinTools } from './registry.ts';
import type {
  CLIOptions,
  CommandFn,
  MiseToolInfo,
  RegistryEntry,
  RegistryModule,
  Shell,
} from './shared.ts';
import { isRegistryHandlerEntry } from './shared.ts';

interface State {
  schema_version: 1;
  tools: Record<string, string>;
}

interface ProvidedByTarget {
  name: string;
  providedBy: string;
  entry: RegistryEntry;
}

interface RegistryIndex {
  byName: Record<string, RegistryEntry>;
  providedBy: ProvidedByTarget[];
}

interface SyncTarget {
  syncName: string;
  info: MiseToolInfo;
  entry: RegistryEntry;
}

const completionFile = (tool: string, shell: Shell): string => {
  const base = tool.split('/').at(-1)!.replaceAll('@', '');
  if (shell === 'zsh') {
    return `_${base}`;
  }
  if (shell === 'fish') {
    return `${base}.fish`;
  }
  return base;
};

const exec = async (
  [cmd, ...args]: string[],
  opts?: { cwd?: string },
): Promise<{ out: string; ok: boolean }> => {
  if (!cmd) {
    throw new Error('cmd is required');
  }
  try {
    const proc = new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'null',
      cwd: opts?.cwd,
    });
    const result = await proc.output();
    return { out: new TextDecoder().decode(result.stdout), ok: result.success };
  } catch {
    return { out: '', ok: false };
  }
};

const readState = async (statePath: string): Promise<State> => {
  try {
    return JSON.parse(await Deno.readTextFile(statePath));
  } catch {
    return { schema_version: 1, tools: {} };
  }
};

const saveState = async (s: State, statePath: string): Promise<void> => {
  await Deno.mkdir(dirname(statePath), { recursive: true });
  await Deno.writeTextFile(statePath, `${JSON.stringify(s, null, 2)}\n`);
};

const importRegistryModule = async (
  path: string,
): Promise<RegistryModule | null> => {
  try {
    await Deno.stat(path);
  } catch {
    return null;
  }
  const url = path.startsWith('https://') ? path : `file://${path}`;
  return await import(url) as RegistryModule;
};

const indexRegistry = (tools: Record<string, RegistryEntry>): RegistryIndex => {
  const byName: RegistryIndex['byName'] = {};
  const providedBy: ProvidedByTarget[] = [];

  for (const [name, entry] of Object.entries(tools)) {
    if (typeof entry === 'function') {
      byName[name] = entry;
      continue;
    }

    if (entry.providedBy) {
      providedBy.push({ name, providedBy: entry.providedBy, entry });
    } else {
      byName[name] = entry;
    }

    for (const alias of entry.aliases ?? []) {
      byName[alias] = entry;
    }
  }

  return { byName, providedBy };
};

const buildSyncTargets = (
  installed: Record<string, MiseToolInfo>,
  index: RegistryIndex,
): SyncTarget[] => {
  const targets: SyncTarget[] = [];
  const seen = new Set<string>();

  for (const [name, info] of Object.entries(installed)) {
    const entry = index.byName[name];
    if (!entry || seen.has(name)) {
      continue;
    }
    seen.add(name);
    targets.push({ syncName: name, info: { ...info, name }, entry });
  }

  for (const { name, providedBy, entry } of index.providedBy) {
    const provider = installed[providedBy];
    if (!provider || seen.has(name)) {
      continue;
    }
    seen.add(name);
    targets.push({
      syncName: name,
      info: { ...provider, name: provider.name },
      entry,
    });
  }

  return targets;
};

const loadRegistry = async (
  userRegistryPath: string,
): Promise<RegistryIndex> => {
  const userRegistry = await importRegistryModule(userRegistryPath);

  return indexRegistry({
    ...builtinTools,
    ...(userRegistry?.tools ?? {}),
    ...customHandlers,
  });
};

const shouldSkipEntry = (
  entry: RegistryEntry,
  enableHttpCompletions: boolean,
  enableBundledCompletions: boolean,
): boolean => {
  if (!isRegistryHandlerEntry(entry)) {
    return false;
  }
  if (entry.source === 'http' && !enableHttpCompletions) {
    return true;
  }
  if (entry.source === 'bundled' && !enableBundledCompletions) {
    return true;
  }
  return false;
};

/** Registry command strings are split on whitespace into argv; use a handler for shell syntax or quoted args. */
const runCommand = async (cmd: string, miseTool: string): Promise<string | null> => {
  const [bin, ...args] = cmd.split(/\s+/);
  if (!bin) {
    return null;
  }
  const { out, ok } = await exec(['mise', 'x', miseTool, '--', bin, ...args]);
  return ok && out.trim() ? out : null;
};

const isCommandFn = (entry: RegistryEntry): entry is CommandFn => typeof entry === 'function';

const supportsShell = (
  entry: RegistryEntry,
  shell: Shell,
  tool: MiseToolInfo,
): boolean => {
  if (isRegistryHandlerEntry(entry)) {
    return true;
  }
  if (isCommandFn(entry)) {
    return entry(tool)[shell] !== undefined;
  }
  return entry[shell] !== undefined;
};

const resolveCompletion = async (
  syncName: string,
  info: MiseToolInfo,
  shell: Shell,
  entry: RegistryEntry,
): Promise<string | null> => {
  const tool: MiseToolInfo = { ...info, name: syncName };
  const miseTool = typeof entry === 'object' && entry.providedBy ? entry.providedBy : syncName;

  if (isRegistryHandlerEntry(entry)) {
    return await entry.handler(tool, shell);
  }

  if (isCommandFn(entry)) {
    const cmd = entry(tool)[shell];
    return cmd ? await runCommand(cmd, miseTool) : null;
  }

  const cmd = entry[shell];
  return cmd ? await runCommand(cmd, miseTool) : null;
};

const discoverTools = async (): Promise<Record<string, MiseToolInfo>> => {
  const { out, ok } = await exec(['mise', 'ls', '--global', '--json']);
  if (!ok || !out.trim()) {
    return {};
  }
  const raw: Record<string, Omit<MiseToolInfo, 'name'>[]> = JSON.parse(out);
  return Object.fromEntries(
    Object.entries(raw).flatMap(([name, list]) => {
      const active = list.find((t) => t.active) ?? list.at(-1);
      return active ? [[name, { ...active, name }]] : [];
    }),
  );
};

const addMiseSelf = async (
  tools: Record<string, MiseToolInfo>,
): Promise<void> => {
  const { out, ok } = await exec(['mise', '--version']);
  if (!ok) {
    return;
  }
  const version = out.trim().split(/\s+/).at(0) ?? '';
  tools.mise = { name: 'mise', version, install_path: '', installed: true, active: true };
};

const writeCompletion = async (
  tool: string,
  shell: Shell,
  content: string,
  completionsPath: string,
): Promise<void> => {
  await Deno.mkdir(completionsPath, { recursive: true });
  await Deno.writeTextFile(join(completionsPath, completionFile(tool, shell)), content);
};

export const cli = async ({
  statePath,
  completionsPath,
  registryPath,
  force = false,
  verbose = false,
  quiet = false,
  shell,
  enableHttpCompletions = true,
  enableBundledCompletions = true,
  disabledTools = [],
}: CLIOptions) => {
  const log = (...msg: unknown[]) => {
    if (verbose) {
      console.log(...msg);
    }
  };

  const disabled = new Set(disabledTools);

  const [state, registry, tools] = await Promise.all([
    readState(statePath),
    loadRegistry(registryPath),
    discoverTools(),
  ]);

  await addMiseSelf(tools);

  const syncTargets = buildSyncTargets(tools, registry);

  const fail = (syncName: string, detail?: string | false) => {
    if (detail !== false) {
      log(detail ?? `  fail   ${syncName} (${shell})`);
    }
    console.warn(`  WARN   ${syncName}: completion generation failed`);
    return 'failed' as const;
  };

  const statuses = await Promise.all(
    syncTargets.map(async ({ syncName, info, entry }) => {
      const provider = typeof entry === 'object' ? entry.providedBy : undefined;
      if (disabled.has(syncName) || (provider && disabled.has(provider))) {
        log(`  disable ${syncName}`);
        return null;
      }

      if (!force && state.tools[syncName] === info.version) {
        log(`  skip   ${syncName}@${info.version}`);
        return 'skipped' as const;
      }

      if (shouldSkipEntry(entry, enableHttpCompletions, enableBundledCompletions)) {
        log(`  no-cmd ${syncName} (${shell})`);
        return null;
      }

      if (!supportsShell(entry, shell, info)) {
        log(`  no-shell ${syncName} (${shell})`);
        return null;
      }

      let content: string | null;
      try {
        content = await resolveCompletion(syncName, info, shell, entry);
      } catch (error) {
        return fail(
          syncName,
          `  error  ${syncName} registry entry (${shell}): ${error}`,
        );
      }

      if (content === null) {
        return fail(syncName);
      }

      if (!content.trim()) {
        return fail(syncName, false);
      }

      await writeCompletion(syncName, shell, content, completionsPath);
      log(
        `  wrote  ${syncName}@${info.version} → ${shell}/${completionFile(syncName, shell)}`,
      );
      state.tools[syncName] = info.version;
      return 'updated' as const;
    }),
  );

  await saveState(state, statePath);

  const count = (s: string) => statuses.filter((r) => r === s).length;
  const parts = [
    `updated: ${count('updated')}`,
    `skipped: ${count('skipped')}`,
  ];
  if (count('failed')) {
    parts.push(`failed: ${count('failed')}`);
  }
  if (!quiet || verbose) {
    console.log(`sync-completions: ${parts.join(', ')}`);
  }
};
