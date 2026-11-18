import type { ProjectMemoryStatus } from '../core/api.ts'
import { loadProjectMemory, type ProjectMemory } from '../core/memory.ts'
import type { TrustStore } from '../core/trust.ts'
import type { TrustState } from '../core/trust-types.ts'

/**
 * Read the project instructions and resolve their trust state.
 *
 * A project with no instructions is always "trusted": there is nothing to
 * inject, so there is nothing to confirm. Warnings without files (a symlinked
 * AGENTS.md, for example) are reported but do not gate a run.
 */
export async function readMemory(
  cwd: string,
  trust: TrustStore,
): Promise<{ memory: ProjectMemory; state: TrustState; status: ProjectMemoryStatus }> {
  const memory = await loadProjectMemory(cwd)
  const state: TrustState =
    memory.files.length > 0 ? await trust.state(cwd, memory.fingerprint) : 'trusted'

  return {
    memory,
    state,
    status: {
      cwd,
      files: memory.files.map((file) => ({ ...file })),
      warnings: memory.warnings.map((warning) => ({ ...warning })),
      fingerprint: memory.fingerprint,
      trust: state,
      bytes: memory.bytes,
      truncated: memory.truncated,
    },
  }
}
