// The tools of the hosts this mod listens to beside its own, so a `tool.call` hook on one of
// them type-checks: the generated MCP declarations only cover the servers connected at a save.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** The Claude desktop app's own task list under the model's latest message. */
    'mcp__ccd_turn__update_plan': {
      items?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; session?: string }>
      scope?: 'first_task' | 'continuation' | 'new_task'
      advance?: boolean
      done?: number[]
      start?: number
    }
  }
}
