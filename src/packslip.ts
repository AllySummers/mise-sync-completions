import { join } from 'node:path';
import { runMise } from './completion-helpers.ts';
import type { Shell } from './shared.ts';

/**
 * `mise` leaves this beside every packslip install. It is the only internal mise layout this
 * module depends on, and only to avoid a subprocess per non-packslip tool.
 */
const STATEMENT_FILE = '.mise-packslip.json';

const isPackslipInstall = async (installPath: string): Promise<boolean> => {
  if (!installPath) {
    return false;
  }
  try {
    return (await Deno.stat(join(installPath, STATEMENT_FILE))).isFile;
  } catch {
    return false;
  }
};

/**
 * Whether mise itself can print `command`'s `shell` completion from its active packslip install
 * (a vendor file, a script derived from a CLI spec, or the tool's own generator). That is the
 * same command mise's shell loaders run, so it answers "will mise load this itself?" directly.
 *
 * Any failure, including a mise too old to know `--tool`, means "no": the caller keeps
 * its own generated completion, and nothing is removed on the strength of a failed probe.
 */
export const hasPackslipCompletion = async (
  installPath: string,
  command: string,
  shell: Shell,
): Promise<boolean> => {
  if (!await isPackslipInstall(installPath)) {
    return false;
  }
  return await runMise(['completion', shell, '--tool', command]) !== null;
};
