import { type GitState, getGitState } from "./git.ts";
import { activeClaimOverlaps } from "./overlap.ts";
import { type CommandResult, okResult, toResult } from "./result.ts";
import type { ClaimRecord } from "./schema.ts";
import { loadClaims } from "./store.ts";

export interface GitContext {
  git: GitState;
  activeClaims: ClaimRecord[];
  overlaps: ReturnType<typeof activeClaimOverlaps>;
}

export function buildGitContext(root: string): CommandResult<GitContext> {
  const git = getGitState(root);
  if (!git.ok || !git.data) {
    return toResult<GitContext>(null, git.errors);
  }
  return okResult({
    git: git.data,
    activeClaims: loadClaims(root).filter((claim) => claim.status === "active"),
    overlaps: activeClaimOverlaps(root),
  });
}
