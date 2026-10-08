export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export type TodoItem = {
  id: string
  text: string
  status: TodoStatus
  /** A short note on why it is blocked, or what was decided. */
  note?: string
}

export type TodoList = {
  title: string
  items: TodoItem[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-todo': { list: TodoList }
  }
}
