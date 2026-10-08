import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodoBoard, TodoItem, TodoList, TodoStatus } from '../types'

const PANE = 'session-todo'
const TOOL = 'mcp__session-todo__todo'
const COMMAND = 'todo'
const DEFAULT_LIST = 'main'
const EMPTY: TodoBoard = { lists: [], nextId: 1 }

const board = atom({ plugin: 'session-todo', key: 'board' } as const, EMPTY)
const settingsOpen = atom({ plugin: 'session-todo', key: 'settingsOpen' } as const, false)
const THEME_CONFIG_KEY = 'session-todo.theme'

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'blocked']

const GLYPH: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  done: '[x]',
  blocked: '[!]',
}

const LEGEND = `${GLYPH.pending} pending  ${GLYPH.in_progress} in progress  ${GLYPH.done} done  ${GLYPH.blocked} blocked  · click a glyph to cycle`

/** What a theme paints: the colour of each status, the accents, and the bar's two glyphs. */
type Theme = {
  status: Record<TodoStatus, string | undefined>
  /** The active list's title; undefined keeps the surface's text colour. */
  title: string | undefined
  /** The percentage and the `now:` lines. */
  accent: string | undefined
  barFill: string
  barRest: string
  /** How many glyphs fit where one plain cell would: under 1 for glyphs the desktop draws wider than a cell. */
  barScale?: number
}

const THEMES: Record<string, Theme> = {
  classic: {
    status: { done: 'green', in_progress: 'yellow', blocked: 'red', pending: undefined },
    title: undefined,
    accent: undefined,
    barFill: '█',
    barRest: '░',
  },
  cyberpunk: {
    status: { done: '#39ff14', in_progress: '#c77dff', blocked: '#ff2975', pending: '#5a3d7a' },
    title: '#c77dff',
    accent: '#39ff14',
    barFill: '▰',
    barRest: '▱',
    barScale: 0.55,
  },
  dracula: {
    status: { done: '#50fa7b', in_progress: '#f1fa8c', blocked: '#ff5555', pending: '#6272a4' },
    title: '#bd93f9',
    accent: '#ff79c6',
    barFill: '█',
    barRest: '░',
  },
  nord: {
    status: { done: '#a3be8c', in_progress: '#ebcb8b', blocked: '#bf616a', pending: '#4c566a' },
    title: '#88c0d0',
    accent: '#81a1c1',
    barFill: '█',
    barRest: '░',
  },
  solarized: {
    status: { done: '#859900', in_progress: '#b58900', blocked: '#dc322f', pending: '#586e75' },
    title: '#268bd2',
    accent: '#2aa198',
    barFill: '█',
    barRest: '░',
  },
  gruvbox: {
    status: { done: '#b8bb26', in_progress: '#fabd2f', blocked: '#fb4934', pending: '#665c54' },
    title: '#fe8019',
    accent: '#83a598',
    barFill: '█',
    barRest: '░',
  },
  monokai: {
    status: { done: '#a6e22e', in_progress: '#e6db74', blocked: '#f92672', pending: '#75715e' },
    title: '#ae81ff',
    accent: '#66d9ef',
    barFill: '█',
    barRest: '░',
  },
  catppuccin: {
    status: { done: '#a6e3a1', in_progress: '#f9e2af', blocked: '#f38ba8', pending: '#585b70' },
    title: '#cba6f7',
    accent: '#89b4fa',
    barFill: '█',
    barRest: '░',
  },
  'tokyo-night': {
    status: { done: '#9ece6a', in_progress: '#e0af68', blocked: '#f7768e', pending: '#565f89' },
    title: '#bb9af7',
    accent: '#7aa2f7',
    barFill: '█',
    barRest: '░',
  },
  'one-dark': {
    status: { done: '#98c379', in_progress: '#e5c07b', blocked: '#e06c75', pending: '#5c6370' },
    title: '#c678dd',
    accent: '#61afef',
    barFill: '█',
    barRest: '░',
  },
}
const DEFAULT_THEME = 'classic'
const THEME_NAMES = Object.keys(THEMES)

function themeName(name: unknown): string {
  return typeof name === 'string' && THEMES[name] ? name : DEFAULT_THEME
}

/** The bar's segments left to right: what is finished, what is moving, what is stuck, what is left. */
const BAR_ORDER: readonly TodoStatus[] = ['done', 'in_progress', 'blocked', 'pending']

type BarSegment = { status: TodoStatus; cells: number }

/** Splits `width` cells between the statuses in proportion, rounding on the running total so the cells always add up. */
function barSegments(items: readonly TodoItem[], width: number): BarSegment[] {
  const total = items.length
  if (total === 0) return [{ status: 'pending', cells: width }]
  const segments: BarSegment[] = []
  let counted = 0
  let drawn = 0
  for (const status of BAR_ORDER) {
    counted += items.filter(item => item.status === status).length
    const edge = Math.round((counted / total) * width)
    segments.push({ status, cells: edge - drawn })
    drawn = edge
  }
  return segments
}

function percentDone(items: readonly TodoItem[]): number {
  if (items.length === 0) return 0
  return Math.round((items.filter(item => item.status === 'done').length / items.length) * 100)
}

type TodoToolInput = {
  action: 'write' | 'add' | 'update' | 'remove' | 'read' | 'clear' | 'drop' | 'focus'
  list?: string
  title?: string
  items?: Array<{ id?: string; text: string; status?: TodoStatus; note?: string }>
  id?: string
  text?: string
  status?: TodoStatus
  note?: string
}

const TOOL_DESCRIPTION = [
  'The todo lists the user watches in the Todo side pane. They are their view of the plan, so keep them current without being asked.',
  'Lists are named (default "main"); items are addressed by id, unique across lists.',
  '- write: replace one list with its steps (list, title, items). Do this before work with three or more steps, or that spans more than one turn, starts. The first list written becomes the active one, drawn first; focus switches it.',
  '- add / update / remove: one item. Mark the step you begin in_progress (prefer one at a time, several when work really runs in parallel), done the moment it finishes, blocked with a note when it waits on the user.',
  '- read: every list as the pane shows it, with ids. Call it after a context compaction.',
  '- clear: empty one list (list) or all. drop: remove a list. focus: make a list the active one.',
  'Use a second list, e.g. "followup", for things to do after the main work (open the PR, report a finding to Jira), so the main list stays focused.',
  'Keep item text short and imperative, one line each. Before reporting a task finished, leave its list true: every item done, items that fell away removed.',
].join('\n')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['write', 'add', 'update', 'remove', 'read', 'clear', 'drop', 'focus'] },
    list: {
      type: 'string',
      description: 'The list name (write, add, clear, drop, focus). Defaults to the active list, or "main".',
    },
    title: { type: 'string', description: 'A heading for the list (write only); defaults to the name.' },
    items: {
      type: 'array',
      description: 'The whole list (write only). Reuse an existing id to keep an item in place.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          note: { type: 'string' },
        },
        required: ['text'],
      },
    },
    id: { type: 'string', description: 'The item (update, remove).' },
    text: { type: 'string', description: 'The item text (add, update).' },
    status: { type: 'string', enum: STATUSES, description: 'The new status (add, update).' },
    note: { type: 'string', description: 'A short note on the item, e.g. why it is blocked (add, update). Empty removes it.' },
  },
  required: ['action'],
}

const PROMPT_SECTION = {
  id: 'session-todo:instructions',
  scope: 'session',
  text: [
    '# Session todo pane',
    `The user sees live todo lists driven by the \`${TOOL}\` tool. Use it instead of narrating the plan: write the steps before any work with three or more steps or that will span more than one turn (a single edit needs no list), mark the step you work on in_progress (prefer one at a time), mark it done the moment it finishes, and add or remove items as the work changes. Keep follow-ups (open the PR, report to Jira, update docs) in a separate list so the main plan stays focused. Before reporting a task finished, leave its list true: every item done, and items that fell away removed. The pane is the user's way of seeing what is left without asking, so a stale list is worse than none. After a context compaction, call read to recover the lists.`,
  ].join('\n'),
} as const

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)
}

function listNamed(todo: TodoBoard, name: string): TodoList | undefined {
  return todo.lists.find(list => list.name.toLowerCase() === name.toLowerCase())
}

function targetList(todo: TodoBoard, name: string | undefined): TodoList | undefined {
  if (name) return listNamed(todo, name)
  if (todo.active) return listNamed(todo, todo.active)
  return todo.lists[0]
}

function allItems(todo: TodoBoard): TodoItem[] {
  return todo.lists.flatMap(list => list.items)
}

function itemById(todo: TodoBoard, id: string | undefined): TodoItem | undefined {
  return id ? allItems(todo).find(item => item.id === id) : undefined
}

/** Lists in the order the pane draws them: the active one first, then creation order. */
function drawn(todo: TodoBoard): TodoList[] {
  const active = todo.active ? listNamed(todo, todo.active) : undefined
  if (!active) return todo.lists
  return [active, ...todo.lists.filter(list => list !== active)]
}

function nextStatus(status: TodoStatus): TodoStatus {
  if (status === 'pending') return 'in_progress'
  if (status === 'in_progress') return 'done'
  return 'pending'
}

function mapItem(todo: TodoBoard, id: string, change: (item: TodoItem) => TodoItem): TodoBoard {
  return {
    ...todo,
    lists: todo.lists.map(list => ({
      ...list,
      items: list.items.map(item => (item.id === id ? change(item) : item)),
    })),
  }
}

function render(todo: TodoBoard): string {
  if (todo.lists.length === 0) return 'Todo: no lists'
  const lines: string[] = []
  let n = 0
  for (const list of drawn(todo)) {
    const done = list.items.filter(item => item.status === 'done').length
    const marker = list.name === todo.active ? ' (active)' : ''
    lines.push(`${list.title} [${list.name}]${marker} ${done}/${list.items.length} done`)
    if (list.items.length === 0) lines.push('  (empty)')
    for (const item of list.items) {
      n++
      lines.push(`  ${GLYPH[item.status]} ${n}. ${item.text} (${item.id})${item.note ? ` — ${item.note}` : ''}`)
    }
  }
  return lines.join('\n')
}

function statusLine(todo: TodoBoard): string | undefined {
  const items = allItems(todo)
  if (items.length === 0) return undefined
  const done = items.filter(item => item.status === 'done').length
  const current = items.filter(item => item.status === 'in_progress')
  const now =
    current.length === 0
      ? ''
      : ` · now: ${current[0]?.text}${current.length > 1 ? ` (+${current.length - 1})` : ''}`
  return `Todo ${done}/${items.length}${now}`
}

function storeKey(sessionId: string): string {
  return `board:${sessionId}`
}

async function commit($: EngineInterface, change: (todo: TodoBoard) => TodoBoard): Promise<TodoBoard> {
  const todo = await update($, board, change)
  $.ui.status(statusLine(todo))
  await $.store.set(storeKey(await $.session.id()), todo)
  return todo
}

async function ensurePane($: EngineInterface): Promise<void> {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) await $.ui.open({ id: PANE, title: 'Todo' })
}

function applyTool(todo: TodoBoard, input: TodoToolInput): TodoBoard | string {
  switch (input.action) {
    case 'read':
      return todo
    case 'write': {
      const name = input.list ?? todo.active ?? DEFAULT_LIST
      if (!isValidName(name)) return `list names are letters, digits, _ and -: ${name}`
      const existing = listNamed(todo, name)
      const others = todo.lists.filter(list => list !== existing)
      const taken = new Set(others.flatMap(list => list.items.map(item => item.id)))
      let nextId = todo.nextId
      const items: TodoItem[] = []
      for (const given of input.items ?? []) {
        if (!given.text) return 'every item needs a text'
        let id = given.id
        if (!id || taken.has(id)) {
          do id = `t${nextId++}`
          while (taken.has(id))
        }
        taken.add(id)
        const item: TodoItem = { id, text: given.text, status: given.status ?? 'pending' }
        if (given.note) item.note = given.note
        items.push(item)
      }
      const list: TodoList = { name: existing?.name ?? name, title: input.title ?? existing?.title ?? name, items }
      const lists = existing ? todo.lists.map(one => (one === existing ? list : one)) : [...todo.lists, list]
      return { lists, active: todo.active ?? list.name, nextId }
    }
    case 'add': {
      if (!input.text) return 'add needs a text'
      let target = targetList(todo, input.list)
      let lists = todo.lists
      if (!target) {
        const name = input.list ?? DEFAULT_LIST
        if (!isValidName(name)) return `list names are letters, digits, _ and -: ${name}`
        target = { name, title: name, items: [] }
        lists = [...lists, target]
      }
      const item: TodoItem = { id: `t${todo.nextId}`, text: input.text, status: input.status ?? 'pending' }
      if (input.note) item.note = input.note
      const added = target
      return {
        ...todo,
        lists: lists.map(list => (list === added ? { ...list, items: [...list.items, item] } : list)),
        active: todo.active ?? added.name,
        nextId: todo.nextId + 1,
      }
    }
    case 'update': {
      const target = itemById(todo, input.id)
      if (!target) return `no item with id ${input.id ?? '(none)'}`
      return mapItem(todo, target.id, item => {
        const changed: TodoItem = { ...item }
        if (input.text) changed.text = input.text
        if (input.status) changed.status = input.status
        if (input.note !== undefined) {
          if (input.note) changed.note = input.note
          else delete changed.note
        }
        return changed
      })
    }
    case 'remove': {
      const target = itemById(todo, input.id)
      if (!target) return `no item with id ${input.id ?? '(none)'}`
      return {
        ...todo,
        lists: todo.lists.map(list => ({ ...list, items: list.items.filter(item => item !== target) })),
      }
    }
    case 'clear': {
      if (!input.list) return { ...todo, lists: todo.lists.map(list => ({ ...list, items: [] })) }
      const target = listNamed(todo, input.list)
      if (!target) return `no list named ${input.list}`
      return { ...todo, lists: todo.lists.map(list => (list === target ? { ...list, items: [] } : list)) }
    }
    case 'drop': {
      const target = input.list ? listNamed(todo, input.list) : undefined
      if (!target) return `no list named ${input.list ?? '(none)'}`
      const lists = todo.lists.filter(list => list !== target)
      return { ...todo, lists, active: todo.active === target.name ? lists[0]?.name : todo.active }
    }
    case 'focus': {
      const target = input.list ? listNamed(todo, input.list) : undefined
      if (!target) return `no list named ${input.list ?? '(none)'}`
      return { ...todo, active: target.name }
    }
    default:
      return `unknown action ${String((input as { action?: unknown }).action)}`
  }
}

/** An item by its number in the pane (counted across lists in drawn order) or by id. */
function byNumber(todo: TodoBoard, arg: string): TodoItem | undefined {
  const items = drawn(todo).flatMap(list => list.items)
  const n = Number.parseInt(arg, 10)
  if (Number.isFinite(n) && n >= 1 && n <= items.length) return items[n - 1]
  return items.find(item => item.id === arg)
}

const USAGE = `Usage: /todo [add [@list] <text> | start <n> | done <n> | remove <n> | clear [list] | drop <list> | focus <list> | theme <${THEME_NAMES.join('|')}>]`

export const register: Register = (on, options) => {
  const themeKey = themeName(options.theme)
  const theme = THEMES[themeKey] as Theme

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'todo',
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: 'The session todo pane: /todo, add [@list] <text>, start <n>, done <n>, remove <n>, clear [list], drop <list>, focus <list>, theme <name>',
      argumentHint: '[add [@list] <text> | start <n> | done <n> | remove <n> | clear [list] | drop <list> | focus <list> | theme <name>]',
    })

    const saved = (await $.store.get(storeKey(await $.session.id()))) as TodoBoard | undefined
    if (saved && Array.isArray(saved.lists)) {
      await update($, board, () => saved)
      $.ui.status(statusLine(saved))
    }

    void $.ui.open({ id: PANE, title: 'Todo' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, board, () => EMPTY)
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, PROMPT_SECTION] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as TodoToolInput
    const before = await read($, board)
    const outcome = applyTool(before, input)
    if (typeof outcome === 'string') return { deny: `todo: ${outcome}` }
    const after = outcome === before ? before : await commit($, () => outcome)
    if (input.action !== 'read') await ensurePane($)
    return { result: render(after) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const todo = await read($, board)

    if (verb === '') {
      await ensurePane($)
      return { text: render(todo) }
    }
    if (verb === 'add') {
      const list = rest[0]?.startsWith('@') ? rest.shift()?.slice(1) : undefined
      const text = rest.join(' ')
      if (!text) return { text: 'Usage: /todo add [@list] <text>' }
      const outcome = applyTool(todo, { action: 'add', list, text })
      if (typeof outcome === 'string') return { text: outcome }
      const after = await commit($, () => outcome)
      await ensurePane($)
      return { text: render(after) }
    }
    if (verb === 'clear' || verb === 'drop' || verb === 'focus') {
      const outcome = applyTool(todo, { action: verb, list: rest[0] })
      if (typeof outcome === 'string') return { text: outcome }
      return { text: render(await commit($, () => outcome)) }
    }
    if (verb === 'start' || verb === 'done' || verb === 'remove') {
      const arg = rest.join(' ')
      const target = byNumber(todo, arg)
      if (!target) return { text: `No item ${arg || '(none)'}. Items are numbered as the pane shows them.` }
      const outcome = applyTool(
        todo,
        verb === 'remove'
          ? { action: 'remove', id: target.id }
          : { action: 'update', id: target.id, status: verb === 'start' ? 'in_progress' : 'done' },
      )
      if (typeof outcome === 'string') return { text: outcome }
      return { text: render(await commit($, () => outcome)) }
    }
    if (verb === 'theme') {
      const name = rest[0]
      if (!name || !THEMES[name]) return { text: `Themes: ${THEME_NAMES.join(', ')}` }
      const set = await $.config.set({ key: THEME_CONFIG_KEY, value: name })
      if (set.deny) return { text: `Could not set the theme: ${set.deny}` }
      return { text: `Theme set to ${name}.` }
    }
    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const todo = await read($, board)
    const lists = drawn(todo)
    const current = lists.flatMap(list => list.items).filter(item => item.status === 'in_progress')

    const toggle = (item: TodoItem) => () =>
      void commit($, todo => mapItem(todo, item.id, one => ({ ...one, status: nextStatus(one.status) })))

    const barWidth = Math.max(8, Math.round(Math.min(32, e.props.bodyColumns - 12) * (theme.barScale ?? 1)))
    const isSettingsOpen = await read($, settingsOpen)

    const settings =
      !isSettingsOpen || e.surface === 'mobile' ? null : (
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text dimColor>Theme</Text>
          {(() => {
            const { Select } = $.ui.resolve(e)
            return (
              <Select
                key="theme"
                value={themeKey}
                options={THEME_NAMES.map(name => ({ value: name, label: name }))}
                onSelect={value => void $.config.set({ key: THEME_CONFIG_KEY, value })}
              />
            )
          })()}
        </Box>
      )

    let n = 0
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            plain
            key="settings"
            label="⚙"
            dimColor={!isSettingsOpen}
            onPress={() => void update($, settingsOpen, open => !open)}
          />
        </Box>
        {settings}
        {lists.length === 0 && (
          <Text dimColor wrap="wrap">
            Nothing planned yet. The agent fills this in as work is planned; /todo add adds your own.
          </Text>
        )}
        {lists.map((list, index) => {
          const done = list.items.filter(item => item.status === 'done').length
          const isActive = list.name === todo.active
          return (
            <Box key={`list:${list.name}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold={isActive} dimColor={!isActive} color={isActive ? theme.title : undefined}>
                  {list.title}
                </Text>
                <Text dimColor>{list.items.length === 0 ? 'empty' : `${done}/${list.items.length} done`}</Text>
              </Box>
              <Box flexDirection="row" gap={1} marginBottom={list.items.length === 0 ? 0 : 1}>
                <Box flexDirection="row">
                  {barSegments(list.items, barWidth)
                    .filter(segment => segment.cells > 0)
                    .map(segment => (
                      <Text
                        key={`bar:${list.name}:${segment.status}`}
                        color={theme.status[segment.status]}
                        dimColor={segment.status === 'pending' && !theme.status.pending}
                      >
                        {(segment.status === 'pending' ? theme.barRest : theme.barFill).repeat(segment.cells)}
                      </Text>
                    ))}
                </Box>
                <Text
                  bold={done === list.items.length && done > 0}
                  dimColor={done !== list.items.length && !theme.accent}
                  color={theme.accent}
                >
                  {`${percentDone(list.items)}%`}
                </Text>
              </Box>
              {list.items.map(item => {
                n++
                return (
                  <Box key={`row:${item.id}`} flexDirection="column">
                    <Box flexDirection="row" gap={1}>
                      <Button
                        plain
                        key={`toggle:${item.id}`}
                        label={GLYPH[item.status]}
                        dimColor={item.status === 'done'}
                        onPress={toggle(item)}
                      />
                      <Text
                        wrap="wrap"
                        bold={item.status === 'in_progress'}
                        dimColor={item.status === 'done'}
                        strikethrough={item.status === 'done'}
                        color={item.status === 'done' ? undefined : theme.status[item.status]}
                      >
                        {`${n}. ${item.text}`}
                      </Text>
                    </Box>
                    {item.note && (
                      <Box paddingLeft={4}>
                        <Text dimColor wrap="wrap">
                          {item.note}
                        </Text>
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        {current.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {current.map(item => (
              <Text key={`now:${item.id}`} dimColor={!theme.accent} color={theme.accent} wrap="wrap">
                {`now: ${item.text}`}
              </Text>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {LEGEND}
          </Text>
        </Box>
      </Box>
    )
  })
}
