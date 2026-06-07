import type { MiseToolInfo } from './shared.ts';

export const standard = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} completion zsh`,
  bash: `${tool.name} completion bash`,
  fish: `${tool.name} completion fish`,
});

export const completions = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} completions zsh`,
  bash: `${tool.name} completions bash`,
  fish: `${tool.name} completions fish`,
});

export const ghStyle = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} completion -s zsh`,
  bash: `${tool.name} completion -s bash`,
  fish: `${tool.name} completion -s fish`,
});

export const generateShell = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} generate-shell-completion zsh`,
  bash: `${tool.name} generate-shell-completion bash`,
  fish: `${tool.name} generate-shell-completion fish`,
});

export const genCompletions = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} gen-completions --shell zsh`,
  bash: `${tool.name} gen-completions --shell bash`,
  fish: `${tool.name} gen-completions --shell fish`,
});

export const completionsFlag = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} --completions zsh`,
  bash: `${tool.name} --completions bash`,
  fish: `${tool.name} --completions fish`,
});
