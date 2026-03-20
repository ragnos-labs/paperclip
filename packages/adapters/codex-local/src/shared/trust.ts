export function hasCodexGitRepoCheckBypassArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--skip-git-repo-check");
}
