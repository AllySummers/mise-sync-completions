import {
  fetchHttpCompletion,
  githubRawUrls,
  readBundledCompletion,
  runMiseCommand,
} from './completion-helpers.ts';
import {
  argcomplete,
  completions,
  completionsFlag,
  genCompletions,
  generateComplete,
  generateShell,
  ghStyle,
  standard,
  standardCommands,
} from './presets.ts';
import type { MiseToolInfo, RegistryEntry, Shell } from './shared.ts';

const QSV_COMPLETION_PATHS: Record<Shell, string> = {
  zsh: 'contrib/completions/examples/qsv.zsh',
  bash: 'contrib/completions/examples/qsv.bash',
  fish: 'contrib/completions/examples/qsv.fish',
};

export const tools: Record<string, RegistryEntry> = {
  // Core tools
  mise: standard,
  kubectl: standard,
  helm: standard,
  docker: standard,
  gh: ghStyle,
  glab: ghStyle,

  // Kubernetes ecosystem
  clusterctl: standard,
  cmctl: standard,
  k9s: standard,
  kind: standard,
  'kubectl-ai': standard,
  minikube: standard,
  kustomize: standard,
  argocd: standard,
  flux: standard,
  istioctl: standard,
  k3d: standard,
  ko: standard,
  kubeseal: standard,
  linkerd: standard,
  skaffold: standard,
  stern: standard,
  talosctl: standard,
  tilt: standard,
  velero: standard,

  // Rust ecosystem
  rustup: completions,
  deno: completions,
  starship: completions,
  uv: generateShell,
  uvx: {
    providedBy: 'uv',
    zsh: 'uvx --generate-shell-completion zsh',
    bash: 'uvx --generate-shell-completion bash',
    fish: 'uvx --generate-shell-completion fish',
  },
  ruff: generateShell,
  ty: generateShell,
  mdbook: completions,
  atuin: genCompletions,
  gitu: genCompletions,
  gitui: genCompletions,
  just: completionsFlag,
  watchexec: completionsFlag,
  usage: completionsFlag,

  // Python tools
  ipython: argcomplete('ipython'),
  patool: argcomplete('patool'),
  poetry: completions,
  ratarmount: argcomplete('ratarmount'),
  pdm: standard,

  // Cloud CLIs
  flyctl: standard,
  doctl: standard,
  railway: standard,
  supabase: completionsFlag,

  // Container tools
  cosign: standard,
  dive: standard,
  dockerfmt: standard,
  grype: standard,
  nerdctl: standard,
  oras: standard,
  pluto: standard,
  podman: standard,
  regctl: standard,
  syft: standard,
  trivy: standard,

  // Dev tools
  'ast-grep': completions,
  aube: standard,
  chezmoi: standard,
  crush: standard,
  cue: standard,
  dagger: standard,
  doggo: completions,
  dyff: standard,
  ghorg: standard,
  gitleaks: standard,
  glow: standard,
  'golangci-lint': standard,
  goreleaser: standard,
  grafanactl: {
    ...standardCommands('grafanactl'),
    aliases: ['aqua:grafana/grafanactl'],
    completionName: 'grafanactl',
  },
  hishtory: standard,
  'asdf-hishtory': {
    ...standardCommands('hishtory'),
    completionName: 'hishtory',
  },
  hugo: standard,
  jules: standard,
  lazygit: standard,
  lefthook: standard,
  'mermaid-ascii': standard,
  oc: standard,
  opencode: standard,
  pulumi: standard,
  rumdl: completions,
  step: standard,
  xh: generateComplete,
  yq: standard,
  whosthere: {
    ...standardCommands('whosthere'),
    aliases: ['github:ramonvermeulen/whosthere'],
    completionName: 'whosthere',
  },

  // Explicit or partial shell support
  'mise-completions-sync': {
    ...standardCommands('misecompsync'),
    aliases: ['github:alltuner/mise-completions-sync'],
    completionName: 'misecompsync',
  },
  bun: {
    zsh: 'bun completions',
    bash: 'bun completions',
    fish: 'bun completions',
  },
  npm: {
    aliases: ['aqua:npm/cli'],
    completionName: 'npm',
    zsh: 'npm completion',
    bash: 'npm completion',
  },
  pnpm: (tool: MiseToolInfo) => ({
    zsh: `${tool.name} completion zsh`,
    bash: `${tool.name} completion bash`,
  }),
  kubectx: {
    zsh: 'kubectx completion zsh',
    bash: 'kubectx completion bash',
  },
  sops: {
    zsh: 'sops completion zsh',
    bash: 'sops completion bash',
  },
  oci: {
    zsh: 'env _OCI_COMPLETE=zsh_source oci',
    bash: 'env _OCI_COMPLETE=bash_source oci',
    fish: 'env _OCI_COMPLETE=fish_source oci',
  },
  saml2aws: {
    zsh: 'saml2aws --completion-script-zsh',
    bash: 'saml2aws --completion-script-bash',
  },
  cargo: {
    zsh: 'rustup completions zsh cargo',
    bash: 'rustup completions bash cargo',
    fish: 'rustup completions fish cargo',
  },
  pipx: {
    ...argcomplete('pipx'),
  },
  node: { bash: 'node --completion-bash' },
  sheldon: {
    zsh: 'sheldon completions --shell zsh',
    bash: 'sheldon completions --shell bash',
    fish: 'sheldon completions --shell fish',
  },
  gt: {
    aliases: [
      'npm:@withgraphite/graphite-cli',
      'github:withgraphite/homebrew-tap',
    ],
    completionName: 'gt',
    zsh: 'gt completion',
    bash: 'gt completion',
    fish: 'gt fish',
  },
  'github:git-town/git-town': {
    completionName: 'git-town',
    zsh: 'git-town completions zsh',
    bash: 'git-town completions bash',
    fish: 'git-town completions fish',
  },
  'github:abhinav/git-spice': {
    completionName: 'git-spice',
    shells: ['zsh', 'bash', 'fish'],
    handler: async (tool, shell) => {
      const completion = await runMiseCommand(tool.name, [
        'git-spice',
        'shell',
        'completion',
        shell,
      ]);
      if (!completion || shell !== 'zsh') {
        return completion;
      }

      // The zsh generator emits an rc-file registration, not an fpath function.
      const wrapped = completion.replace(
        /^complete (-C .+) git-spice$/m,
        '_bash_complete $1',
      );
      return wrapped === completion ? null : `#compdef git-spice\n${wrapped}`;
    },
  },
  fnox: {
    ...standardCommands('fnox'),
    requires: 'usage',
  },
  hk: {
    ...standardCommands('hk'),
    requires: 'usage',
  },
  pitchfork: {
    ...standardCommands('pitchfork'),
    requires: 'usage',
  },
  codex: standard,
  caddy: standard,
  'github:microsoft/apm': {
    completionName: 'apm',
    zsh: 'env _APM_COMPLETE=zsh_source apm',
    bash: 'env _APM_COMPLETE=bash_source apm',
    fish: 'env _APM_COMPLETE=fish_source apm',
  },
  'github:KarnerTh/mermerd': {
    ...standardCommands('mermerd'),
    completionName: 'mermerd',
  },
  'npm:neon': {
    completionName: 'neon',
    shells: ['zsh'],
    handler: async (tool) => {
      const completion = await runMiseCommand(tool.name, ['neon', 'completion']);
      return completion?.replaceAll('neonctl', 'neon') ?? null;
    },
  },
  flux2: {
    ...standardCommands('flux'),
    completionName: 'flux',
  },
  fx: {
    zsh: 'fx --comp zsh',
    bash: 'fx --comp bash',
    fish: 'fx --comp fish',
  },
  pkl: {
    zsh: 'pkl shell-completion zsh',
    bash: 'pkl shell-completion bash',
    fish: 'pkl shell-completion fish',
  },
  television: {
    completionName: 'tv',
    zsh: 'tv init zsh',
    bash: 'tv init bash',
    fish: 'tv init fish',
  },
  jj: {
    zsh: 'jj util completion zsh',
    bash: 'jj util completion bash',
    fish: 'jj util completion fish',
  },
  openspec: {
    aliases: ['npm:@fission-ai/openspec'],
    completionName: 'openspec',
    zsh: 'openspec completion generate zsh',
    bash: 'openspec completion generate bash',
    fish: 'openspec completion generate fish',
  },
  prek: {
    zsh: 'prek util generate-shell-completion zsh',
    bash: 'prek util generate-shell-completion bash',
    fish: 'prek util generate-shell-completion fish',
  },
  task: {
    zsh: 'task --completion zsh',
    bash: 'task --completion bash',
    fish: 'task --completion fish',
  },
  bat: {
    zsh: 'bat --completion zsh',
    bash: 'bat --completion bash',
    fish: 'bat --completion fish',
  },
  fd: {
    zsh: 'fd --gen-completions zsh',
    bash: 'fd --gen-completions bash',
    fish: 'fd --gen-completions fish',
  },
  delta: {
    zsh: 'delta --generate-completion zsh',
    bash: 'delta --generate-completion bash',
    fish: 'delta --generate-completion fish',
  },
  zellij: {
    zsh: 'zellij setup --generate-completion zsh',
    bash: 'zellij setup --generate-completion bash',
    fish: 'zellij setup --generate-completion fish',
  },
  restic: {
    zsh: 'restic generate --zsh-completion -',
    bash: 'restic generate --bash-completion -',
    fish: 'restic generate --fish-completion -',
  },
  rclone: {
    zsh: 'rclone completion zsh -',
    bash: 'rclone completion bash -',
    fish: 'rclone completion fish -',
  },
  'scaleway-cli': {
    zsh: 'scw autocomplete script shell=zsh',
    bash: 'scw autocomplete script shell=bash',
    fish: 'scw autocomplete script shell=fish',
  },
  rg: {
    aliases: ['ripgrep'],
    completionName: 'rg',
    zsh: 'rg --generate complete-zsh',
    bash: 'rg --generate complete-bash',
    fish: 'rg --generate complete-fish',
  },
  'tree-sitter': {
    zsh: 'tree-sitter complete --shell zsh',
    bash: 'tree-sitter complete --shell bash',
    fish: 'tree-sitter complete --shell fish',
  },
  nix: {
    zsh: 'nix --extra-experimental-features nix-command completion zsh',
    bash: 'nix --extra-experimental-features nix-command completion bash',
    fish: 'nix --extra-experimental-features nix-command completion fish',
  },

  // External tools
  qsv: {
    source: 'http',
    handler: async (tool, shell) =>
      await fetchHttpCompletion(
        githubRawUrls('dathere/qsv', tool.version, QSV_COMPLETION_PATHS),
        shell,
      ),
  },

  hyperfine: {
    source: 'bundled',
    handler: async (tool, shell) =>
      await readBundledCompletion(tool.install_path, 'hyperfine-v*', 'autocomplete', {
        zsh: '_hyperfine',
        bash: 'hyperfine.bash',
        fish: 'hyperfine.fish',
      }, shell),
  },

  killport: {
    source: 'bundled',
    handler: async (tool, shell) =>
      await readBundledCompletion(tool.install_path, 'killport-*', 'completions', {
        zsh: '_killport',
        bash: 'killport.bash',
        fish: 'killport.fish',
      }, shell),
  },
};
