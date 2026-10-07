import { basename, dirname, join, resolve } from 'node:path';
import { miseToolSpec, runMise } from './completion-helpers.ts';
import { handlers as customHandlers } from './custom-completions.ts';
import { hasPackslipCompletion } from './packslip.ts';
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

/** Bump when generated output changes for an unchanged tool version, to invalidate cached files. */
const GENERATOR_REVISION = 2;

interface OutputRecord {
  shell: Shell;
  command: string;
  sync_name: string;
  /** mise tool whose install provides the completion. */
  tool: string;
  version: string;
  install_path: string;
  /** Pinned `tool@version` specs the generator ran with, so upgrading a `requires` tool regenerates. */
  specs: string[];
  /** `generated`: this task wrote the file. `packslip`: mise loads the completion itself. */
  provider: 'generated' | 'packslip';
  revision: number;
  /** sha256 of the generated file as written; the proof of ownership required before removing it. */
  sha256?: string;
}

interface State {
  schema_version: 2;
  /** Keyed by absolute output path, so shells and destinations never share a record. */
  outputs: Record<string, OutputRecord>;
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
  completionName: string;
  info: MiseToolInfo;
  entry: RegistryEntry;
  path: string;
}

type OnDisk = { kind: 'missing' } | { kind: 'file'; sha256: string } | { kind: 'other' };

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

const emptyState = (): State => ({ schema_version: 2, outputs: {} });

const readState = async (statePath: string): Promise<State> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(statePath));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`  WARN   ignoring unreadable state ${statePath}: ${error}`);
    }
    return emptyState();
  }
  const state = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<State>;
  return state.schema_version === 2
    ? { ...emptyState(), outputs: state.outputs ?? {} }
    : emptyState();
};

const writeAtomic = async (path: string, content: string | Uint8Array): Promise<void> => {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${Deno.pid}.tmp`);
  if (typeof content === 'string') {
    await Deno.writeTextFile(tmp, content);
  } else {
    await Deno.writeFile(tmp, content);
  }
  await Deno.rename(tmp, path);
};

const saveState = async (s: State, statePath: string): Promise<void> => {
  await writeAtomic(statePath, `${JSON.stringify(s, null, 2)}\n`);
};

const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 100;

/**
 * Serializes whole runs (postinstall hooks, manual runs) that share one state file. Waits for a
 * concurrent run, but gives up after `timeoutMs` rather than hanging forever behind a stuck one.
 */
const lockState = async (statePath: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<Deno.FsFile> => {
  await Deno.mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const file = await Deno.open(lockPath, { create: true, write: true });
  const deadline = Date.now() + timeoutMs;
  while (!await file.tryLock(true)) {
    if (Date.now() >= deadline) {
      file.close();
      throw new Error(
        `timed out after ${timeoutMs / 1000}s waiting for ${lockPath}; another sync-completions ` +
          'run holds it. If none is running, delete the lock file.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  return file;
};

const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex();

const inspectOutput = async (path: string): Promise<OnDisk> => {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { kind: 'missing' };
    }
    throw error;
  }
  if (!info.isFile) {
    return { kind: 'other' };
  }
  return { kind: 'file', sha256: await sha256(await Deno.readFile(path)) };
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

interface MiseRegistryRecord {
  short: string;
  backends?: string[];
  bins?: string[];
  aliases?: string[];
}

/** mise's own registry, or `[]` when it can't be read. Never throws. */
const loadMiseRegistry = async (): Promise<MiseRegistryRecord[]> => {
  const out = await runMise(['registry', '--json']);
  if (!out) {
    return [];
  }
  try {
    const records = JSON.parse(out);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
};

/**
 * Maps installs with no registry entry of their own to the names mise's registry knows the tool
 * by, so they can reuse that entry. An install matches a record by its short name, an alias, or
 * (with options stripped) one of its backends, e.g. `aqua:cilium/hubble` or `cilium-hubble`. The
 * candidates are the record's short name, binaries, then aliases, keeping those with an entry.
 */
const resolveRegistryNames = (
  installedNames: string[],
  records: MiseRegistryRecord[],
  index: RegistryIndex,
): Record<string, string[]> => {
  const wanted = new Set(installedNames.filter((name) => !index.byName[name]));
  const names: Record<string, string[]> = {};
  if (!wanted.size) {
    return names;
  }
  for (const { short, backends = [], bins = [], aliases = [] } of records) {
    const known = [short, ...aliases, ...backends.map((b) => b.replace(/\[.*$/, ''))];
    for (const name of wanted.intersection(new Set(known))) {
      const list = names[name] ??= [];
      for (const candidate of [short, ...bins, ...aliases]) {
        if (index.byName[candidate] && !list.includes(candidate)) {
          list.push(candidate);
        }
      }
    }
  }
  return names;
};

const buildSyncTargets = (
  installed: Record<string, MiseToolInfo>,
  index: RegistryIndex,
  shell: Shell,
  outputDir: string,
  backendNames: Record<string, string[]> = {},
): SyncTarget[] => {
  const targets: SyncTarget[] = [];
  const target = (syncName: string, info: MiseToolInfo, entry: RegistryEntry): SyncTarget => {
    const completionName = typeof entry === 'object' ? entry.completionName ?? syncName : syncName;
    return {
      syncName,
      completionName,
      info,
      entry,
      path: join(outputDir, completionFile(completionName, shell)),
    };
  };

  for (const [name, info] of Object.entries(installed)) {
    const entry = index.byName[name];
    if (entry) {
      targets.push(target(name, { ...info, name }, entry));
      continue;
    }
    // Known to mise's registry (by short name, alias, or backend) under a name we have an entry
    // for: sync under that name, but keep the installed name in `info` so generation runs the
    // exact install.
    const short = backendNames[name]?.at(0);
    if (short) {
      targets.push(target(short, { ...info, name }, index.byName[short]!));
    }
  }

  for (const { name, providedBy, entry } of index.providedBy) {
    const provider = installed[providedBy];
    if (provider) {
      targets.push(target(name, provider, entry));
    }
  }

  return targets;
};

const isProvidedBy = (t: SyncTarget): boolean =>
  typeof t.entry === 'object' && !!t.entry.providedBy;

/** Prefer the canonical registry name, then a direct install over `providedBy`, then name order. */
const compareOwners = (a: SyncTarget, b: SyncTarget): number =>
  Number(a.syncName !== a.completionName) - Number(b.syncName !== b.completionName) ||
  Number(isProvidedBy(a)) - Number(isProvidedBy(b)) ||
  Number(a.info.name !== a.syncName) - Number(b.info.name !== b.syncName) ||
  (a.syncName < b.syncName ? -1 : a.syncName > b.syncName ? 1 : 0);

/** The name to show for a target: the full backend name when it was matched through one. */
const label = (t: SyncTarget): string => isProvidedBy(t) ? t.syncName : t.info.name;

const assignOwners = (targets: SyncTarget[]) => {
  const byPath = Map.groupBy(targets, (t) => t.path);
  const owners: SyncTarget[] = [];
  const shadowed: { target: SyncTarget; owner: SyncTarget }[] = [];
  for (const group of byPath.values()) {
    const [owner, ...rest] = group.toSorted(compareOwners);
    owners.push(owner!);
    shadowed.push(...rest.map((target) => ({ target, owner: owner! })));
  }
  return { owners, shadowed };
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
const runCommand = (cmd: string, miseTools: string[]): Promise<string | null> => {
  const [bin, ...args] = cmd.split(/\s+/);
  return bin ? runMise(['x', ...miseTools, '--', bin, ...args]) : Promise.resolve(null);
};

const isCommandFn = (entry: RegistryEntry): entry is CommandFn => typeof entry === 'function';

const supportsShell = (
  entry: RegistryEntry,
  shell: Shell,
  tool: MiseToolInfo,
): boolean => {
  if (isRegistryHandlerEntry(entry)) {
    return entry.shells?.includes(shell) ?? true;
  }
  if (isCommandFn(entry)) {
    return entry(tool)[shell] !== undefined;
  }
  return entry[shell] !== undefined;
};

/** The pinned `tool@version` specs a target's generator runs under: its provider, then `requires`. */
const generatorSpecs = (
  { info, entry }: SyncTarget,
  tools: Record<string, MiseToolInfo>,
): string[] => {
  // `info` is the install providing the command, whatever backend it came from, so it can differ
  // from the registry name (`syncName`).
  const provider = info.name;
  const requirements = typeof entry === 'object'
    ? Array.isArray(entry.requires) ? entry.requires : entry.requires ? [entry.requires] : []
    : [];
  return [
    miseToolSpec(info),
    ...requirements.filter((name) => name !== provider).map((name) => {
      const found = tools[name];
      return found ? miseToolSpec({ ...found, name }) : name;
    }),
  ];
};

const resolveCompletion = async (
  t: SyncTarget,
  shell: Shell,
  miseTools: string[],
): Promise<string | null> => {
  const { syncName, info, entry } = t;
  // `name` is the command (handlers and command presets build argv from it); `provider` is the
  // mise tool to run it under, which differs for `providedBy` entries.
  const tool: MiseToolInfo = { ...info, name: syncName, provider: info.name };

  if (isRegistryHandlerEntry(entry)) {
    return await entry.handler(tool, shell);
  }

  if (isCommandFn(entry)) {
    const cmd = entry(tool)[shell];
    return cmd ? await runCommand(cmd, miseTools) : null;
  }

  const cmd = entry[shell];
  return cmd ? await runCommand(cmd, miseTools) : null;
};

/** The installed version each global tool selects, or `null` when discovery fails. */
const discoverTools = async (): Promise<Record<string, MiseToolInfo> | null> => {
  // `--global` lists global config only, but `active` is still resolved from the cwd, hence `/`.
  const out = await runMise(['ls', '--global', '--json']);
  if (!out) {
    return null;
  }
  let raw: Record<string, Omit<MiseToolInfo, 'name'>[]>;
  try {
    raw = JSON.parse(out);
  } catch {
    return null;
  }
  return Object.fromEntries(
    Object.entries(raw).flatMap(([name, list]) => {
      const selected = list.find((t) => t.active && t.installed);
      return selected ? [[name, { ...selected, name }]] : [];
    }),
  );
};

/** `mise ls` does not list mise itself. */
const addMiseSelf = async (tools: Record<string, MiseToolInfo>): Promise<void> => {
  const version = (await runMise(['--version']))?.trim().split(/\s+/).at(0);
  if (version) {
    tools.mise = { name: 'mise', version, install_path: '', installed: true, active: true };
  }
};

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/** `file` is the on-disk state of the record's path; a generated record owns it only if hashes match. */
const owns = (record: OutputRecord | undefined, file: OnDisk): boolean =>
  record?.provider === 'generated' && file.kind === 'file' && file.sha256 === record.sha256;

const isCacheHit = (
  record: OutputRecord | undefined,
  t: SyncTarget,
  specs: string[],
  onDisk: OnDisk,
): boolean =>
  owns(record, onDisk) && record!.revision === GENERATOR_REVISION &&
  record!.sync_name === t.syncName && record!.command === t.completionName &&
  record!.tool === t.info.name && record!.version === t.info.version &&
  record!.install_path === t.info.install_path && sameList(record!.specs ?? [], specs);

const baseRecord = (t: SyncTarget, shell: Shell, specs: string[]) => ({
  shell,
  command: t.completionName,
  sync_name: t.syncName,
  tool: t.info.name,
  version: t.info.version,
  install_path: t.info.install_path,
  specs,
  revision: GENERATOR_REVISION,
});

export const cli = async (options: CLIOptions): Promise<void> => {
  const lock = await lockState(options.statePath, options.lockTimeoutMs);
  try {
    await sync(options);
  } finally {
    lock.close();
  }
};

const sync = async ({
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
}: CLIOptions): Promise<void> => {
  const log = (...msg: unknown[]) => {
    if (verbose) {
      console.log(...msg);
    }
  };

  const disabled = new Set(disabledTools);
  const outputDir = resolve(completionsPath);

  const [state, registry, discovered, miseRegistry] = await Promise.all([
    readState(statePath),
    loadRegistry(registryPath),
    discoverTools(),
    loadMiseRegistry(),
  ]);

  const tools = { ...discovered };
  await addMiseSelf(tools);

  const backendNames = resolveRegistryNames(Object.keys(tools), miseRegistry, registry);
  const { owners, shadowed } = assignOwners(
    buildSyncTargets(tools, registry, shell, outputDir, backendNames),
  );
  for (const { target, owner } of shadowed) {
    log(`  shadow ${label(target)}: ${label(owner)} owns ${shell}/${basename(owner.path)}`);
  }

  const isDisabled = ({ syncName, completionName, entry }: SyncTarget) => {
    const provider = typeof entry === 'object' ? entry.providedBy : undefined;
    return disabled.has(syncName) || disabled.has(completionName) ||
      (!!provider && disabled.has(provider));
  };

  const counts = { updated: 0, skipped: 0, failed: 0, packslip: 0, removed: 0, preserved: 0 };
  /** Paths whose record and file must survive reconciliation this run. */
  const retained = new Set<string>();

  const fail = (syncName: string, detail?: string | false) => {
    if (detail !== false) {
      log(detail ?? `  fail   ${syncName} (${shell})`);
    }
    console.warn(`  WARN   ${syncName}: completion generation failed`);
    counts.failed++;
  };

  /** Mise loads this completion itself: retire our file if (and only if) we wrote it unchanged. */
  const handOff = async (t: SyncTarget) => {
    const record = state.outputs[t.path];
    const file = `${shell}/${basename(t.path)}`;
    const onDisk = await inspectOutput(t.path);
    if (owns(record, onDisk)) {
      await Deno.remove(t.path);
      counts.removed++;
      log(`  retire ${t.syncName} → ${file} (mise loads it natively)`);
    } else if (record?.provider === 'generated' && onDisk.kind !== 'missing') {
      console.warn(`  WARN   ${t.syncName}: ${file} changed since it was written; preserved`);
    } else if (onDisk.kind !== 'missing') {
      log(`  keep   ${file} (not written by this task)`);
    }
    state.outputs[t.path] = { ...baseRecord(t, shell, []), provider: 'packslip' };
    counts.packslip++;
    log(`  packslip ${t.syncName}@${t.info.version} (${shell})`);
  };

  /** Run one target's work, logging its elapsed time when verbose. */
  const timed = async (t: SyncTarget, work: () => Promise<void>) => {
    const start = performance.now();
    try {
      await work();
    } finally {
      log(`  time   ${t.syncName} (${shell}): ${(performance.now() - start).toFixed(1)}ms`);
    }
  };

  const settled = await Promise.allSettled(
    owners.map((t) =>
      timed(t, async () => {
        const { syncName, info, entry, path } = t;
        if (isDisabled(t)) {
          log(`  disable ${syncName}`);
          retained.add(path);
          return;
        }

        if (await hasPackslipCompletion(info.install_path, t.completionName, shell)) {
          retained.add(path);
          await handOff(t);
          return;
        }

        if (shouldSkipEntry(entry, enableHttpCompletions, enableBundledCompletions)) {
          log(`  no-cmd ${syncName} (${shell})`);
          retained.add(path);
          return;
        }

        if (!supportsShell(entry, shell, info)) {
          log(`  no-shell ${syncName} (${shell})`);
          return;
        }

        retained.add(path);
        const specs = generatorSpecs(t, tools);
        const record = state.outputs[path];
        const onDisk = await inspectOutput(path);
        if (!force && isCacheHit(record, t, specs, onDisk)) {
          log(`  skip   ${syncName}@${info.version}`);
          counts.skipped++;
          return;
        }
        // Only overwrite what this task wrote and nobody has touched since.
        if (onDisk.kind !== 'missing' && !owns(record, onDisk)) {
          const why = record?.provider === 'generated'
            ? 'changed since it was written'
            : 'was not written by this task';
          console.warn(`  WARN   ${syncName}: ${shell}/${basename(path)} ${why}; preserved`);
          counts.preserved++;
          return;
        }

        let content: string | null;
        try {
          content = await resolveCompletion(t, shell, specs);
        } catch (error) {
          return fail(syncName, `  error  ${syncName} registry entry (${shell}): ${error}`);
        }

        if (content === null) {
          return fail(syncName);
        }

        if (!content.trim()) {
          return fail(syncName, false);
        }

        const bytes = new TextEncoder().encode(content);
        const hash = await sha256(bytes);
        await writeAtomic(path, bytes);
        state.outputs[path] = {
          ...baseRecord(t, shell, specs),
          provider: 'generated',
          sha256: hash,
        };
        log(`  wrote  ${syncName}@${info.version} → ${shell}/${basename(path)}`);
        counts.updated++;
      })
    ),
  );

  // A target that threw may have skipped `retained.add`, so its file must not look orphaned.
  // An empty or failed inventory must never authorize removing files either.
  const failures = settled.filter((r) => r.status === 'rejected');
  try {
    if (!failures.length && discovered && Object.keys(discovered).length) {
      for (const [path, record] of Object.entries(state.outputs)) {
        if (record.shell !== shell || dirname(path) !== outputDir || retained.has(path)) {
          continue;
        }
        delete state.outputs[path];
        if (record.provider !== 'generated') {
          continue;
        }
        const onDisk = await inspectOutput(path);
        if (owns(record, onDisk)) {
          await Deno.remove(path);
          counts.removed++;
          log(
            `  remove ${record.sync_name} → ${shell}/${basename(path)} (no longer a sync target)`,
          );
        } else if (onDisk.kind !== 'missing') {
          console.warn(
            `  WARN   ${record.sync_name}: ${shell}/${
              basename(path)
            } changed since it was written; preserved`,
          );
        }
      }
    }
  } finally {
    // Always persist: files written this run must stay recognizable as ours next run.
    await saveState(state, statePath);
  }

  if (failures.length) {
    for (const { reason } of failures.slice(1)) {
      console.warn(`  WARN   ${reason}`);
    }
    throw failures[0]!.reason;
  }

  const parts = [
    `updated: ${counts.updated}`,
    `skipped: ${counts.skipped}`,
    `packslip: ${counts.packslip}`,
  ];
  for (const key of ['removed', 'preserved', 'failed'] as const) {
    if (counts[key]) {
      parts.push(`${key}: ${counts[key]}`);
    }
  }
  if (!quiet || verbose) {
    console.log(`sync-completions: ${parts.join(', ')}`);
  }
};
