import { fetchHttpCompletion, githubRawUrls, readBundledCompletion } from './completion-helpers.ts';
import {
  completions,
  completionsFlag,
  genCompletions,
  generateShell,
  ghStyle,
  standard,
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
  mdbook: generateShell,
  atuin: genCompletions,
  gitu: genCompletions,
  gitui: genCompletions,
  just: completionsFlag,
  watchexec: completionsFlag,
  usage: completionsFlag,

  // Python tools
  poetry: completions,

  // Cloud CLIs
  flyctl: standard,
  doctl: standard,
  oci: standard,
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
  fnox: standard,
  gitleaks: standard,
  'golangci-lint': standard,
  goreleaser: standard,
  hk: standard,
  hugo: standard,
  lazygit: standard,
  lefthook: standard,
  oc: standard,
  pitchfork: standard,
  pulumi: standard,
  restic: standard,
  rumdl: completions,
  saml2aws: standard,
  step: standard,
  xh: standard,
  yq: standard,

  // Explicit or partial shell support
  bun: {
    zsh: 'bun completions',
    bash: 'bun completions',
    fish: 'bun completions',
  },
  npm: {
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
  cargo: {
    zsh: 'rustup completions zsh cargo',
    bash: 'rustup completions bash cargo',
    fish: 'rustup completions fish cargo',
  },
  pipx: {
    zsh: 'register-python-argcomplete pipx',
    bash: 'register-python-argcomplete pipx',
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
    zsh: 'gt completion',
    bash: 'gt completion',
    fish: 'gt fish',
  },
  'github:git-town/git-town': {
    zsh: 'git-town completions zsh',
    bash: 'git-town completions bash',
    fish: 'git-town completions fish',
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
  'scaleway-cli': {
    zsh: 'scw autocomplete script shell=zsh',
    bash: 'scw autocomplete script shell=bash',
    fish: 'scw autocomplete script shell=fish',
  },
  rg: {
    aliases: ['ripgrep'],
    zsh: 'rg --generate complete-zsh',
    bash: 'rg --generate complete-bash',
    fish: 'rg --generate complete-fish',
  },
  'tree-sitter': {
    zsh: 'tree-sitter complete --shell zsh',
    bash: 'tree-sitter complete --shell bash',
    fish: 'tree-sitter complete --shell fish',
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
