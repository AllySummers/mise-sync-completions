import type { MiseToolInfo, ShellCommands, ShellCommandsEntry } from './shared.ts';

export const standardCommands = (name: string): ShellCommands => ({
  zsh: `${name} completion zsh`,
  bash: `${name} completion bash`,
  fish: `${name} completion fish`,
});

export const standard = (tool: MiseToolInfo) => standardCommands(tool.name);

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

export const generateComplete = (tool: MiseToolInfo) => ({
  zsh: `${tool.name} --generate=complete-zsh`,
  bash: `${tool.name} --generate=complete-bash`,
  fish: `${tool.name} --generate=complete-fish`,
});

export const argcomplete = (command: string): ShellCommandsEntry => ({
  requires: 'pipx:argcomplete',
  zsh: `register-python-argcomplete -s zsh ${command}`,
  bash: `register-python-argcomplete -s bash ${command}`,
  fish: `register-python-argcomplete -s fish ${command}`,
});
