/**
 * User-defined completion handlers for tools that need custom logic.
 *
 * Keys are mise tool names as reported by `mise ls --json`.
 * Vendoring this repo and editing this file is the supported way to add handlers.
 */

import type { RegistryEntry } from './shared.ts';

export const handlers: Record<string, RegistryEntry> = {};
