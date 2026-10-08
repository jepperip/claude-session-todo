export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export type TodoItem = {
  /** Unique across every list, so an item is addressed by id alone. */
  id: string
  text: string
  status: TodoStatus
  /** A short note on why it is blocked, or what was decided. */
  note?: string
}

export type TodoList = {
  /** What the tool and /todo address the list by. */
  name: string
  title: string
  /** One short line under the title saying what the list is for; optional, at most ABOUT_MAX characters. */
  about?: string
  items: TodoItem[]
}

export type TodoBoard = {
  /** In creation order; the active list is drawn first whatever its position. */
  lists: TodoList[]
  /** The name of the list the agent is working in, drawn first with a bold title. */
  active?: string
  /** Feeds the next item id, so ids stay unique after removals. */
  nextId: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-todo': {
      board: TodoBoard
      /** Whether the pane's settings row (the theme selector) is unfolded. */
      settingsOpen: boolean
      /** The item that just went from in progress to done, shown on the band for a moment; null otherwise. */
      justDone: { id: string; text: string } | null
      /** Whether the pane has already opened on its own this session; it does so once at most. */
      paneAutoOpened: boolean
    }
  }
}
