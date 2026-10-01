import assert from 'node:assert/strict';
import { defaultCompletionsPath } from '../src/paths.ts';

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) {
        Deno.env.delete(k);
      } else {
        Deno.env.set(k, v);
      }
    }
  };
  apply(vars);
  try {
    fn();
  } finally {
    apply(saved);
  }
};

Deno.test('bash writes to the first BASH_COMPLETION_USER_DIR entry, else XDG', () => {
  withEnv({ BASH_COMPLETION_USER_DIR: '/a:/b', XDG_DATA_HOME: '/xdg' }, () => {
    assert.equal(defaultCompletionsPath('bash'), '/a/completions');
  });
  withEnv({ BASH_COMPLETION_USER_DIR: ':/b', XDG_DATA_HOME: '/xdg' }, () => {
    assert.equal(defaultCompletionsPath('bash'), '/b/completions');
  });
  withEnv({ BASH_COMPLETION_USER_DIR: undefined, XDG_DATA_HOME: '/xdg' }, () => {
    assert.equal(defaultCompletionsPath('bash'), '/xdg/bash-completion/completions');
  });
});

Deno.test('zsh and fish ignore BASH_COMPLETION_USER_DIR', () => {
  withEnv({ BASH_COMPLETION_USER_DIR: '/a', XDG_DATA_HOME: '/xdg' }, () => {
    assert.equal(defaultCompletionsPath('zsh'), '/xdg/mise-completions/zsh');
    assert.equal(defaultCompletionsPath('fish'), '/xdg/mise-completions/fish');
  });
});
