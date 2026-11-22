import type { PermissionMode, RiskLevel } from '../types.ts'

export interface PermissionRequest {
  id: string
  tool: string
  summary: string
  /** The full call text when the summary truncates it, such as a long Bash command. */
  detail?: string
  risk: RiskLevel
}

export type PermissionDecision = 'allow_once' | 'allow_session' | 'deny'

export type PermissionFn = (request: PermissionRequest) => Promise<PermissionDecision>

/**
 * Decides whether a tool call may run.
 *
 * This is a UX layer, not a security boundary. Command allowlists cannot contain
 * a shell; the real boundary is that every path is resolved inside the project
 * and every process is killed with its group.
 */
export class PermissionBroker {
  private readonly sessionAllows = new Set<string>()
  private readonly mode: PermissionMode
  private readonly ask: PermissionFn

  constructor(mode: PermissionMode, ask: PermissionFn) {
    this.mode = mode
    this.ask = ask
  }

  /**
   * True when `check` would call `ask`. The loop uses this to decide whether to
   * emit a `permission_request` event, so low-risk calls never flash a card.
   */
  requiresApproval(request: PermissionRequest): boolean {
    return !this.isAutoAllowed(request)
  }

  /**
   * Plan mode is read-only. Mutating tools are refused outright rather than
   * prompted, because a prompt would imply the action can be approved.
   */
  isBlockedByMode(request: PermissionRequest): boolean {
    return this.mode === 'plan' && request.risk !== 'low'
  }

  async check(request: PermissionRequest): Promise<boolean> {
    if (this.isAutoAllowed(request)) return true

    const decision = await this.ask(request)
    if (decision === 'allow_session') this.sessionAllows.add(request.tool)
    return decision !== 'deny'
  }

  private isAutoAllowed(request: PermissionRequest): boolean {
    if (this.mode === 'bypass') return true

    // Read-only until the plan is approved.
    if (this.mode === 'plan') return request.risk === 'low'

    if (this.mode === 'acceptEdits') {
      if (request.tool === 'Write' || request.tool === 'Edit' || request.tool === 'TodoWrite') {
        return true
      }
      if (request.risk === 'low') return true
      // Execution still requires an explicit answer.
    }

    if (request.risk === 'low') return true
    return this.sessionAllows.has(request.tool)
  }
}
