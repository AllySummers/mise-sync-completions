/**
 * Read-only inspection of the packslip statement mise keeps beside an install, to decide whether
 * mise can load a command's completion natively.
 *
 * `.mise-packslip.json`, `.mise-packslip-artifact`, and the `.mise-packslip/` resource layout are
 * internal to mise, not a public API. The rules below follow mise v2026.9.17
 * (`src/packslip.rs` completion_sources, `src/packslip/completions.rs` activate) and packslip 1.4.
 */

import { join, sep } from 'node:path';
import type { Shell } from './shared.ts';

export const STATEMENT_FILE = '.mise-packslip.json';
export const SELECTED_ARTIFACT_FILE = '.mise-packslip-artifact';
const RESOURCES_DIR = '.mise-packslip';
const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://packslip.dev/release/v1';
const BARE_FORMATS = ['raw', 'gz', 'xz', 'zst', 'bz2'];
/** The only cli-spec format mise derives completions from. */
const SUPPORTED_SPEC_FORMAT = 'usage';

/** `file`/`spec` are static files in the install; `exec`/`spec-exec` run the tool when completing. */
export type NativeSource = 'file' | 'spec' | 'exec' | 'spec-exec';

export type PackslipInspection =
  | {
    outcome: 'native';
    command: string;
    source: NativeSource;
    /** A declared generator that has not been run; mise runs it on demand. */
    generator: boolean;
    path?: string;
    reason: string;
  }
  | { outcome: 'legacy'; command: string; reason: string }
  | { outcome: 'needs-attention'; command: string; reason: string };

export interface Host {
  os: string;
  arch: string;
}

type ResourceSource = 'archive' | 'asset' | 'repo' | 'exec';

interface Artifact {
  name: string;
  os?: string;
  arch?: string;
  libc?: string;
  variant?: string;
  format?: string;
  bins: string[];
}

interface Resource {
  kind: string;
  artifact?: string;
  os?: string;
  arch?: string;
  libc?: string;
  shell?: string;
  shells: string[];
  bin?: string;
  format?: string;
  archive?: string;
  asset?: string;
  repo?: string;
  exec: string[];
}

interface Statement {
  artifacts: Artifact[];
  resources: Resource[];
}

class InvalidStatement extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (obj: Json, key: string): string | undefined => {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new InvalidStatement(`${key} is not a string`);
  }
  return value;
};

const stringList = (obj: Json, key: string): string[] => {
  const value = obj[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new InvalidStatement(`${key} is not a list of strings`);
  }
  return value;
};

/** A command as typed at a shell: `tool.exe` is `tool`. */
export const commandName = (name: string): string =>
  name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name;

const fileName = (path: string): string => path.split('/').at(-1) ?? path;

/** Artifact `bin` entries are a bare archive path or `{ path, name }`. */
const binName = (bin: unknown): string => {
  if (typeof bin === 'string' && bin) {
    return commandName(fileName(bin));
  }
  if (isObject(bin) && typeof bin.path === 'string' && typeof bin.name === 'string' && bin.name) {
    return commandName(bin.name);
  }
  throw new InvalidStatement('an artifact bin entry is malformed');
};

const parseArtifact = (raw: unknown): Artifact => {
  if (!isObject(raw)) {
    throw new InvalidStatement('an artifact is not an object');
  }
  const name = optionalString(raw, 'name');
  if (!name) {
    throw new InvalidStatement('an artifact has no name');
  }
  const bins = raw.bin ?? [];
  if (!Array.isArray(bins)) {
    throw new InvalidStatement(`artifact ${name} bin is not a list`);
  }
  return {
    name,
    os: optionalString(raw, 'os'),
    arch: optionalString(raw, 'arch'),
    libc: optionalString(raw, 'libc'),
    variant: optionalString(raw, 'variant'),
    format: optionalString(raw, 'format'),
    bins: bins.map(binName),
  };
};

const parseResource = (raw: unknown): Resource => {
  if (!isObject(raw)) {
    throw new InvalidStatement('a resource is not an object');
  }
  const kind = optionalString(raw, 'kind');
  if (!kind) {
    throw new InvalidStatement('a resource has no kind');
  }
  return {
    kind,
    artifact: optionalString(raw, 'artifact'),
    os: optionalString(raw, 'os'),
    arch: optionalString(raw, 'arch'),
    libc: optionalString(raw, 'libc'),
    shell: optionalString(raw, 'shell'),
    shells: stringList(raw, 'shells'),
    bin: optionalString(raw, 'bin'),
    format: optionalString(raw, 'format'),
    archive: optionalString(raw, 'archive'),
    asset: optionalString(raw, 'asset'),
    repo: optionalString(raw, 'repo'),
    exec: stringList(raw, 'exec'),
  };
};

const parseStatement = (raw: unknown): Statement => {
  if (!isObject(raw)) {
    throw new InvalidStatement('the statement is not an object');
  }
  if (raw._type !== STATEMENT_TYPE) {
    throw new InvalidStatement(`_type is ${JSON.stringify(raw._type)}, not ${STATEMENT_TYPE}`);
  }
  if (raw.predicateType !== PREDICATE_TYPE) {
    throw new InvalidStatement(
      `predicateType ${JSON.stringify(raw.predicateType)} is not ${PREDICATE_TYPE}`,
    );
  }
  const predicate = raw.predicate;
  if (!isObject(predicate)) {
    throw new InvalidStatement('predicate is not an object');
  }
  if (!Array.isArray(predicate.artifacts) || predicate.artifacts.length === 0) {
    throw new InvalidStatement('predicate.artifacts is empty or not a list');
  }
  const resources = predicate.resources ?? [];
  if (!Array.isArray(resources)) {
    throw new InvalidStatement('predicate.resources is not a list');
  }
  return {
    artifacts: predicate.artifacts.map(parseArtifact),
    resources: resources.map(parseResource),
  };
};

/** The one source a resource declares; none or several is invalid. */
const resourceSource = (r: Resource): ResourceSource | undefined => {
  const sources = ([
    [r.archive !== undefined, 'archive'],
    [r.asset !== undefined, 'asset'],
    [r.repo !== undefined, 'repo'],
    [r.exec.length > 0, 'exec'],
  ] as const).filter(([present]) => present);
  return sources.length === 1 ? sources[0]![1] : undefined;
};

const resourceFits = (r: Resource, artifact: Artifact): boolean => {
  const insideBareArtifact = r.archive !== undefined &&
    BARE_FORMATS.includes(artifact.format ?? '');
  return !insideBareArtifact &&
    (r.artifact === undefined || r.artifact === artifact.name) &&
    (r.os === undefined || r.os === artifact.os) &&
    (r.arch === undefined || r.arch === artifact.arch) &&
    (r.libc === undefined || r.libc === artifact.libc);
};

const specificity = (r: Resource): number =>
  (r.artifact !== undefined ? 4 : 0) + [r.os, r.arch, r.libc].filter(Boolean).length;

/** Identities of completion and cli-spec entries; only entries sharing one compete over scope. */
const identities = (r: Resource, soleBin: string | undefined): string[] => {
  if (r.kind === 'cli-spec') {
    return [JSON.stringify([r.kind, r.format ?? '', r.bin ? commandName(r.bin) : ''])];
  }
  const bin = r.bin ?? soleBin;
  const id = (...parts: string[]) =>
    JSON.stringify([r.kind, ...(bin !== undefined ? [commandName(bin)] : []), ...parts]);
  const shells = [...(r.shell ? [r.shell] : []), ...r.shells];
  return shells.length ? shells.map((shell) => id(shell)) : [id()];
};

/** Per identity, the entries fitting the artifact that name the most platform fields. */
const selectResources = (
  resources: Resource[],
  artifact: Artifact,
  soleBin: string | undefined,
): Resource[] => {
  const ids = resources.map((r) => identities(r, soleBin));
  const keep = new Set<Resource>();
  const seen = new Set<string>();
  for (const own of ids) {
    for (const identity of own) {
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      const fitting = resources.filter((r, i) =>
        ids[i]!.includes(identity) && resourceFits(r, artifact)
      );
      const best = Math.max(0, ...fitting.map(specificity));
      for (const r of fitting) {
        if (specificity(r) === best) {
          keep.add(r);
        }
      }
    }
  }
  return resources.filter((r) => keep.has(r));
};

const isPlainFileName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);

const isSafeRelative = (rel: string): boolean =>
  rel !== '' && rel.split('/').every(isPlainFileName);

/** A regular file whose real path stays inside the install. */
const fileInside = async (root: string, path: string): Promise<boolean> => {
  try {
    const [realRoot, real] = await Promise.all([Deno.realPath(root), Deno.realPath(path)]);
    return real.startsWith(realRoot + sep) && (await Deno.stat(real)).isFile;
  } catch {
    return false;
  }
};

const firstFileInside = async (root: string, candidates: string[]): Promise<string | undefined> => {
  for (const candidate of candidates) {
    if (await fileInside(root, candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const resourcePath = async (installPath: string, r: Resource): Promise<string | undefined> => {
  switch (resourceSource(r)) {
    case 'archive': {
      const rel = r.archive!;
      if (!isSafeRelative(rel)) {
        return undefined;
      }
      // mise strips a lone top-level archive directory on extraction.
      const stripped = rel.includes('/')
        ? [join(installPath, rel.slice(rel.indexOf('/') + 1))]
        : [];
      return await firstFileInside(installPath, [join(installPath, rel), ...stripped]);
    }
    case 'asset':
      return isPlainFileName(r.asset!)
        ? await firstFileInside(installPath, [join(installPath, RESOURCES_DIR, 'assets', r.asset!)])
        : undefined;
    case 'repo':
      return isSafeRelative(r.repo!)
        ? await firstFileInside(installPath, [join(installPath, RESOURCES_DIR, 'repo', r.repo!)])
        : undefined;
    default:
      return undefined;
  }
};

const SOURCE_RANK: Record<ResourceSource, number> = { archive: 0, asset: 1, repo: 2, exec: 3 };

const sourceRank = (r: Resource): number => SOURCE_RANK[resourceSource(r) ?? 'exec'];

/** The recorded artifact, else the single host build when the record is absent or stale. */
const selectedArtifact = async (
  statement: Statement,
  installPath: string,
  host: Host,
): Promise<Artifact | string> => {
  let recorded: string | undefined;
  try {
    recorded = (await Deno.readTextFile(join(installPath, SELECTED_ARTIFACT_FILE))).trim();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return `cannot read ${SELECTED_ARTIFACT_FILE}: ${error}`;
    }
  }
  const named = statement.artifacts.find((a) => a.name === recorded);
  if (named) {
    return named;
  }
  const candidates = statement.artifacts.filter((a) =>
    a.variant === undefined &&
    (a.os === undefined || a.os === host.os) &&
    (a.arch === undefined || a.arch === host.arch)
  );
  const builds = new Set(candidates.map((a) => JSON.stringify([a.os, a.arch, a.libc])));
  if (builds.size === 1) {
    return candidates[0]!;
  }
  const what = recorded === undefined
    ? `no ${SELECTED_ARTIFACT_FILE}`
    : `${SELECTED_ARTIFACT_FILE} names unknown artifact ${recorded}`;
  return `${what}, and ${candidates.length} artifacts match ${host.os}/${host.arch}`;
};

const currentHost = (): Host => ({ os: Deno.build.os, arch: Deno.build.arch });

/**
 * Whether mise loads `command`'s `shell` completion natively from the install at `installPath`.
 * Never runs the tool, downloads anything, or treats unreadable metadata as "not a packslip".
 */
export const inspectPackslip = async (
  installPath: string,
  command: string,
  shell: Shell,
  host: Host = currentHost(),
): Promise<PackslipInspection> => {
  const name = commandName(command);
  const legacy = (reason: string): PackslipInspection => ({
    outcome: 'legacy',
    command: name,
    reason,
  });
  const attention = (reason: string): PackslipInspection => ({
    outcome: 'needs-attention',
    command: name,
    reason,
  });
  const native = (
    source: NativeSource,
    reason: string,
    path?: string,
  ): PackslipInspection => ({
    outcome: 'native',
    command: name,
    source,
    generator: source === 'exec' || source === 'spec-exec',
    reason,
    ...(path ? { path } : {}),
  });

  if (!installPath) {
    return legacy('no install path');
  }

  let text: string;
  try {
    text = await Deno.readTextFile(join(installPath, STATEMENT_FILE));
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? legacy('not installed from a packslip')
      : attention(`cannot read ${STATEMENT_FILE}: ${error}`);
  }

  let statement: Statement;
  try {
    statement = parseStatement(JSON.parse(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return attention(`unrecognized ${STATEMENT_FILE}: ${detail}`);
  }

  const artifact = await selectedArtifact(statement, installPath, host);
  if (typeof artifact === 'string') {
    return attention(`cannot tell which artifact is installed: ${artifact}`);
  }
  // mise registers loaders only for executables of the installed artifact.
  if (!artifact.bins.includes(name)) {
    return legacy(`installed artifact ${artifact.name} has no ${name} executable`);
  }

  const allBins = new Set(statement.artifacts.flatMap((a) => a.bins));
  const soleBin = allBins.size === 1 ? [...allBins][0] : undefined;
  const selected = selectResources(
    statement.resources.filter((r) => r.kind === 'completion' || r.kind === 'cli-spec'),
    artifact,
    soleBin,
  );

  const completions = selected
    .filter((r) =>
      r.kind === 'completion' &&
      (r.bin !== undefined ? commandName(r.bin) : soleBin) === name &&
      (r.shell === shell || r.shells.includes(shell))
    )
    .sort((a, b) => sourceRank(a) - sourceRank(b));
  const specs = selected
    .filter((r) => r.kind === 'cli-spec' && r.bin !== undefined && commandName(r.bin) === name)
    .sort((a, b) => sourceRank(a) - sourceRank(b));

  for (const r of completions.filter((r) => resourceSource(r) !== 'exec')) {
    const path = await resourcePath(installPath, r);
    if (path) {
      return native('file', `${resourceSource(r)} ${shell} completion`, path);
    }
  }

  const unsupported = new Set<string>();
  for (const r of specs.filter((r) => resourceSource(r) !== 'exec')) {
    const path = await resourcePath(installPath, r);
    if (!path) {
      continue;
    }
    if (r.format === SUPPORTED_SPEC_FORMAT) {
      return native('spec', `${resourceSource(r)} ${r.format} cli-spec`, path);
    }
    unsupported.add(r.format ?? '(none)');
  }

  if (completions.some((r) => resourceSource(r) === 'exec')) {
    return native('exec', `declared ${shell} completion generator (not yet run)`);
  }
  for (const r of specs.filter((r) => resourceSource(r) === 'exec')) {
    if (r.format === SUPPORTED_SPEC_FORMAT) {
      return native('spec-exec', `declared ${r.format} cli-spec generator (not yet run)`);
    }
    unsupported.add(r.format ?? '(none)');
  }

  if (unsupported.size) {
    return attention(
      `only offers cli-spec formats mise cannot derive completions from: ${
        [...unsupported].join(', ')
      }`,
    );
  }
  if (completions.length || specs.length) {
    return attention(
      `declares a ${shell} completion for ${name}, but none of its files are in the install`,
    );
  }
  return legacy(`packslip declares no ${shell} completion for ${name}`);
};
