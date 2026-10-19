/**
 * Paths that are never scanned for symbols or sent to an analysis model: dependency trees, build
 * output, lockfiles, and common secret-bearing files, plus the user's configured prefixes.
 */
const DEFAULT_EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
]);

const SECRET_OR_GENERATED_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*\.p12|.*\.pfx|yarn\.lock|package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|go\.sum|.*\.min\.(js|css))$/i;

export function isPathExcludedFromIntelligence(path: string, configuredPrefixes: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment))) return true;
  if (SECRET_OR_GENERATED_FILE.test(normalized)) return true;
  return configuredPrefixes.some((prefix) => {
    const cleanPrefix = prefix.replace(/\\/g, '/').replace(/^\.\//, '');
    return cleanPrefix.length > 0 && normalized.startsWith(cleanPrefix);
  });
}
