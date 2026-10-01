import { basename, dirname, join, resolve } from 'node:path';
import { miseToolSpec } from './completion-helpers.ts';
import { handlers as customHandlers } from './custom-completions.ts';
import { inspectPackslip, type NativeSource, type PackslipInspection } from './packslip.ts';
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

/** Bump when legacy output changes for an unchanged tool version, to invalidate cached files. */
const GENERATOR_REVISION = 1;
/** The mise release whose packslip install layout `packslip.ts` was written against. */
export const MIN_MISE_VERSION = '2026.9.17';

interface OutputRecord {
  shell: Shell;
  command: string;
  sync_name: string;
  /** mise tool whose install provides the completion. */
  tool: string;
  version: string;
  install_path: string;
  provider: 'legacy' | 'native';
  revision: number;
  /** sha256 of the legacy file as written; the proof of ownership required before removing it. */
  sha256?: string;
  native_source?: NativeSource;
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

type NativeInspection = Extract<PackslipInspection, { outcome: 'native' }>;

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

const exec = async ([cmd, ...args]: string[]): Promise<{ out: string; ok: boolean }> => {
  if (!cmd) {
    throw new Error('cmd is required');
  }
  try {
    const proc = new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'null',
      // `mise x`/`mise ls` have no global-only mode; `/` has no project config above it.
      cwd: '/',
    });
    const result = await proc.output();
    return { out: new TextDecoder().decode(result.stdout), ok: result.success };
  } catch {
    return { out: '', ok: false };
  }
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

/** Serializes whole runs (postinstall hooks, manual runs) that share one state file. */
const lockState = async (statePath: string): Promise<Deno.FsFile> => {
  await Deno.mkdir(dirname(statePath), { recursive: true });
  const file = await Deno.open(`${statePath}.lock`, { create: true, write: true });
  await file.lock(true);
  return file;
};

const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
};

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

const buildSyncTargets = (
  installed: Record<string, MiseToolInfo>,
  index: RegistryIndex,
  shell: Shell,
  outputDir: string,
): SyncTarget[] => {
  const targets: SyncTarget[] = [];
  const seen = new Set<string>();
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
    if (!entry || seen.has(name)) {
      continue;
    }
    seen.add(name);
    targets.push(target(name, { ...info, name }, entry));
  }

  for (const { name, providedBy, entry } of index.providedBy) {
    const provider = installed[providedBy];
    if (!provider || seen.has(name)) {
      continue;
    }
    seen.add(name);
    targets.push(target(name, { ...provider, name: provider.name }, entry));
  }

  return targets;
};

const isProvidedBy = (t: SyncTarget): boolean =>
  typeof t.entry === 'object' && !!t.entry.providedBy;

/** Prefer the canonical registry name, then a direct install over `providedBy`, then name order. */
const compareOwners = (a: SyncTarget, b: SyncTarget): number =>
  Number(a.syncName !== a.completionName) - Number(b.syncName !== b.completionName) ||
  Number(isProvidedBy(a)) - Number(isProvidedBy(b)) ||
  (a.syncName < b.syncName ? -1 : a.syncName > b.syncName ? 1 : 0);

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
const runCommand = async (cmd: string, miseTools: string[]): Promise<string | null> => {
  const [bin, ...args] = cmd.split(/\s+/);
  if (!bin) {
    return null;
  }
  const { out, ok } = await exec(['mise', 'x', ...miseTools, '--', bin, ...args]);
  return ok && out.trim() ? out : null;
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

const resolveCompletion = async (
  { syncName, info, entry }: SyncTarget,
  shell: Shell,
  tools: Record<string, MiseToolInfo>,
): Promise<string | null> => {
  const tool: MiseToolInfo = { ...info, name: syncName };
  const provider = typeof entry === 'object' && entry.providedBy ? entry.providedBy : syncName;
  const requirements = typeof entry === 'object'
    ? Array.isArray(entry.requires) ? entry.requires : entry.requires ? [entry.requires] : []
    : [];
  const pinned = (name: string) => {
    const found = tools[name];
    return found ? miseToolSpec({ ...found, name }) : name;
  };
  const miseTools = [provider, ...requirements.filter((name) => name !== provider)].map(pinned);

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
  const { out, ok } = await exec(['mise', 'ls', '--global', '--json']);
  if (!ok || !out.trim()) {
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

const addMiseSelf = async (
  tools: Record<string, MiseToolInfo>,
): Promise<string | undefined> => {
  const { out, ok } = await exec(['mise', '--version']);
  if (!ok) {
    return undefined;
  }
  const version = out.trim().split(/\s+/).at(0) ?? '';
  tools.mise = { name: 'mise', version, install_path: '', installed: true, active: true };
  return version;
};

export const versionAtLeast = (version: string, min: string): boolean => {
  const parts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const [have, want] = [parts(version), parts(min)];
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff) {
      return diff > 0;
    }
  }
  return true;
};

const requireMiseVersion = (version: string | undefined): void => {
  if (!version) {
    throw new Error('cannot determine the mise version (`mise --version` failed)');
  }
  if (!versionAtLeast(version, MIN_MISE_VERSION)) {
    throw new Error(
      `mise ${version} is older than ${MIN_MISE_VERSION}, the release whose packslip layout this task understands; upgrade mise`,
    );
  }
};

const isCacheHit = (record: OutputRecord | undefined, t: SyncTarget, onDisk: OnDisk): boolean =>
  record?.provider === 'legacy' && record.revision === GENERATOR_REVISION &&
  record.sync_name === t.syncName && record.command === t.completionName &&
  record.tool === t.info.name && record.version === t.info.version &&
  record.install_path === t.info.install_path &&
  onDisk.kind === 'file' && onDisk.sha256 === record.sha256;

const baseRecord = (t: SyncTarget, shell: Shell) => ({
  shell,
  command: t.completionName,
  sync_name: t.syncName,
  tool: t.info.name,
  version: t.info.version,
  install_path: t.info.install_path,
  revision: GENERATOR_REVISION,
});

const nativeRecord = (t: SyncTarget, shell: Shell, decision: NativeInspection): OutputRecord => ({
  ...baseRecord(t, shell),
  provider: 'native',
  native_source: decision.source,
});

export const cli = async (options: CLIOptions): Promise<void> => {
  const lock = await lockState(options.statePath);
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

  const [state, registry, discovered] = await Promise.all([
    readState(statePath),
    loadRegistry(registryPath),
    discoverTools(),
  ]);

  const tools = { ...discovered };
  requireMiseVersion(await addMiseSelf(tools));

  const { owners, shadowed } = assignOwners(
    buildSyncTargets(tools, registry, shell, outputDir),
  );
  for (const { target, owner } of shadowed) {
    log(`  shadow ${target.syncName}: ${owner.syncName} owns ${shell}/${basename(owner.path)}`);
  }

  const isDisabled = ({ syncName, completionName, entry }: SyncTarget) => {
    const provider = typeof entry === 'object' ? entry.providedBy : undefined;
    return disabled.has(syncName) || disabled.has(completionName) ||
      (!!provider && disabled.has(provider));
  };

  const counts = { updated: 0, skipped: 0, failed: 0, native: 0, removed: 0 };
  const attention: string[] = [];
  const pending: string[] = [];
  /** Paths whose record and file must survive reconciliation this run. */
  const retained = new Set<string>();

  const fail = (syncName: string, detail?: string | false) => {
    if (detail !== false) {
      log(detail ?? `  fail   ${syncName} (${shell})`);
    }
    console.warn(`  WARN   ${syncName}: completion generation failed`);
    counts.failed++;
  };

  const handOff = async (t: SyncTarget, decision: NativeInspection) => {
    const record = state.outputs[t.path];
    const file = `${shell}/${basename(t.path)}`;
    const onDisk = await inspectOutput(t.path);
    if (record?.provider === 'legacy' && onDisk.kind !== 'missing') {
      if (onDisk.kind === 'file' && onDisk.sha256 === record.sha256) {
        await Deno.remove(t.path);
        counts.removed++;
        log(`  retire ${t.syncName} → ${file} (mise loads it natively)`);
      } else {
        console.warn(`  WARN   ${t.syncName}: ${file} changed since it was written; preserved`);
      }
    } else if (onDisk.kind !== 'missing') {
      log(`  keep   ${file} (not written by this task)`);
    }
    state.outputs[t.path] = nativeRecord(t, shell, decision);
    counts.native++;
    log(`  native ${t.syncName}@${t.info.version} (${shell}: ${decision.reason})`);
  };

  await Promise.all(
    owners.map(async (t) => {
      const { syncName, info, entry, path } = t;
      if (isDisabled(t)) {
        log(`  disable ${syncName}`);
        retained.add(path);
        return;
      }

      const decision = await inspectPackslip(info.install_path, t.completionName, shell);
      if (decision.outcome === 'native') {
        if (!decision.generator) {
          retained.add(path);
          await handOff(t, decision);
          return;
        }
        pending.push(syncName);
        log(`  pending ${syncName} (${decision.reason}; keeping legacy completion)`);
      } else if (decision.outcome === 'needs-attention') {
        attention.push(syncName);
        console.warn(
          `  WARN   ${syncName}: packslip ${decision.reason}; keeping legacy completion`,
        );
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
      const onDisk = await inspectOutput(path);
      if (!force && isCacheHit(state.outputs[path], t, onDisk)) {
        log(`  skip   ${syncName}@${info.version}`);
        counts.skipped++;
        return;
      }
      if (onDisk.kind === 'other') {
        console.warn(`  WARN   ${syncName}: ${path} is not a regular file; preserved`);
        counts.failed++;
        return;
      }

      let content: string | null;
      try {
        content = await resolveCompletion(t, shell, tools);
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
      await writeAtomic(path, bytes);
      log(`  wrote  ${syncName}@${info.version} → ${shell}/${basename(path)}`);
      state.outputs[path] = {
        ...baseRecord(t, shell),
        provider: 'legacy',
        sha256: await sha256(bytes),
      };
      counts.updated++;
    }),
  );

  // An empty or failed inventory must never authorize removing files.
  if (discovered && Object.keys(discovered).length) {
    for (const [path, record] of Object.entries(state.outputs)) {
      if (record.shell !== shell || dirname(path) !== outputDir || retained.has(path)) {
        continue;
      }
      delete state.outputs[path];
      if (record.provider !== 'legacy') {
        continue;
      }
      const onDisk = await inspectOutput(path);
      if (onDisk.kind === 'file' && onDisk.sha256 === record.sha256) {
        await Deno.remove(path);
        counts.removed++;
        log(`  remove ${record.sync_name} → ${shell}/${basename(path)} (no longer a sync target)`);
      } else if (onDisk.kind !== 'missing') {
        console.warn(
          `  WARN   ${record.sync_name}: ${path} changed since it was written; preserved`,
        );
      }
    }
  }

  await saveState(state, statePath);

  const parts = [
    `updated: ${counts.updated}`,
    `skipped: ${counts.skipped}`,
    `native: ${counts.native}`,
  ];
  if (counts.removed) {
    parts.push(`removed: ${counts.removed}`);
  }
  if (counts.failed) {
    parts.push(`failed: ${counts.failed}`);
  }
  if (attention.length) {
    parts.push(`needs-attention: ${attention.length}`);
  }
  if (pending.length) {
    parts.push(`pending: ${pending.length}`);
  }
  if (!quiet || verbose) {
    console.log(`sync-completions: ${parts.join(', ')}`);
  }
};
