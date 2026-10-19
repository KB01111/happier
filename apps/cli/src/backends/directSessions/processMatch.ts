/**
 * Cross-platform helpers for recognizing agent CLI processes from a process snapshot.
 *
 * Ported from AgentMonitor (`crates/agentmonitor/src/adapter/process_match.rs`),
 * https://github.com/jiweiyeah/AgentMonitor, Copyright (c) 2025-2026 jiweiyeah, MIT License.
 *
 * Windows reports executables with `.exe`/`.cmd`/`.bat`/`.ps1` suffixes and backslash separators,
 * so comparisons normalize separators and strip executable suffixes before matching.
 */

export type ObservedProcess = Readonly<{
  name: string;
  /** Full command line when the platform exposes it (not available on Windows via ps-list). */
  cmd?: string;
}>;

const EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1'] as const;

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripExecutableSuffix(value: string): string {
  const lower = value.toLowerCase();
  for (const suffix of EXECUTABLE_SUFFIXES) {
    if (lower.endsWith(suffix)) return value.slice(0, value.length - suffix.length);
  }
  return value;
}

/** True for a bare invocation (no path separator) whose name, minus any executable suffix, is `name`. */
export function bareNameMatches(arg: string, name: string): boolean {
  if (arg.includes('/') || arg.includes('\\')) return false;
  return stripExecutableSuffix(arg) === name;
}

/** True when `arg` ends with `suffix` after separator normalization and suffix stripping. */
export function pathEndsWith(arg: string, suffix: string): boolean {
  return stripExecutableSuffix(normalizeSeparators(arg)).endsWith(normalizeSeparators(suffix));
}

/** True when `arg` contains `needle` after separator normalization. */
export function pathContains(arg: string, needle: string): boolean {
  return normalizeSeparators(arg).includes(normalizeSeparators(needle));
}

/**
 * The tokens a matcher inspects: the full argv when the platform exposes it, otherwise the process
 * name. Preferring argv keeps path-qualified look-alikes (an editor-bundled `codex` app-server) from
 * matching on their bare basename.
 */
export function processTokens(process: ObservedProcess): string[] {
  const argv = process.cmd?.split(/\s+/).filter(Boolean) ?? [];
  return argv.length > 0 ? argv : [process.name];
}
