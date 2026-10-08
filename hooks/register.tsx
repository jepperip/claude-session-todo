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
const THEME_FIELD = 'theme'

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'blocked']

// The empty box holds a figure space (U+2007), as wide as a digit, so it lines up with [x] where a
// proportional font would draw a plain space narrower.
const GLYPH: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  done: '[x]',
  blocked: '[!]',
}

const LEGEND = `${GLYPH.pending} pending  ${GLYPH.in_progress} in progress  ${GLYPH.done} done  ${GLYPH.blocked} blocked  · click a glyph to cycle`

/** What a theme paints: the colour of each status, the accents, and the bar's two glyphs. */
type Theme = {
  /** Per status: the bar segment and, for in progress and blocked, the item text. Pending and done text keep the surface's colours. */
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
  const counts = BAR_ORDER.map(status => ({ status, count: items.filter(item => item.status === status).length }))
  const present = counts.filter(one => one.count > 0)
  // Every status that has an item gets at least one cell, so a lone blocked item still shows on a
  // short bar; the rest of the width is shared in proportion, the largest remainders rounding up.
  // With more statuses than cells (a bar under four cells) the floor cannot hold and the shares
  // fall back to plain proportion.
  const floor = present.length <= width ? 1 : 0
  const spare = width - floor * present.length
  const shares = present.map(one => {
    const exact = (one.count / total) * spare
    return { status: one.status, cells: floor + Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let left = width - shares.reduce((sum, one) => sum + one.cells, 0)
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (left === 0) break
    share.cells += 1
    left -= 1
  }
  return shares.map(({ status, cells }) => ({ status, cells }))
}

function percentDone(items: readonly TodoItem[]): number {
  if (items.length === 0) return 0
  return Math.round((items.filter(item => item.status === 'done').length / items.length) * 100)
}

/** The longest `about` line a list may carry: one short sentence, never a paragraph. */
const ABOUT_MAX = 80

type TodoToolInput = {
  action: 'write' | 'add' | 'update' | 'remove' | 'read' | 'clear' | 'drop' | 'focus' | 'describe'
  list?: string
  title?: string
  about?: string
  items?: Array<{ id?: string; text: string; status?: TodoStatus; note?: string }>
  id?: string
  text?: string
  status?: TodoStatus
  note?: string
}

const TOOL_DESCRIPTION = [
  'The todo lists the user watches in the Todo side pane. They are their view of the plan, so keep them current without being asked.',
  'Lists are named (default "main"); items are addressed by id, unique across lists.',
  '- write: replace one list with its steps (list, title, items, optional about). Do this before work with three or more steps, or that spans more than one turn, starts. The first list written becomes the active one, drawn first; focus switches it.',
  `- about (optional, one line of at most ${ABOUT_MAX} characters; a longer one is cut with an ellipsis): one short sentence under the title saying what the list is for or what done looks like, so the user still knows a day later. Not a summary of the items. Set it with write and leave it; describe changes it later.`,
  '- add / update / remove: one item. Mark the step you begin in_progress (prefer one at a time, several when work really runs in parallel), done the moment it finishes, blocked with a note when it waits on the user.',
  '- read: every list as the pane shows it, with ids. Call it after a context compaction.',
  '- clear: empty one list (list) or all. drop: remove a list. focus: make a list the active one. describe: set or clear a list\'s about (list, about).',
  'Use a second list, e.g. "followup", for things to do after the main work (open the PR, report a finding to Jira), so the main list stays focused.',
  'Keep item text short and imperative, one line each. Before reporting a task finished, leave its list true: every item done, items that fell away removed.',
].join('\n')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['write', 'add', 'update', 'remove', 'read', 'clear', 'drop', 'focus', 'describe'] },
    list: {
      type: 'string',
      description: 'The list name (write, add, clear, drop, focus, describe). Defaults to the active list, or "main".',
    },
    title: { type: 'string', description: 'A heading for the list (write only); defaults to the name.' },
    about: {
      type: 'string',
      description: `One short line under the title saying what the list is for (write, describe). Optional; at most ${ABOUT_MAX} characters, a longer one is cut. Empty clears it.`,
    },
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
    `The user sees live todo lists driven by the \`${TOOL}\` tool. Use it instead of narrating the plan: write the steps before any work with three or more steps or that will span more than one turn (a single edit needs no list), mark the step you work on in_progress (prefer one at a time), mark it done the moment it finishes, and add or remove items as the work changes. Keep follow-ups (open the PR, report to Jira, update docs) in a separate list so the main plan stays focused. A list may carry an optional \`about\`: one short sentence on what it is for, set when the list is written and then left alone. Before reporting a task finished, leave its list true: every item done, and items that fell away removed. The pane is the user's way of seeing what is left without asking, so a stale list is worse than none. After a context compaction, call read to recover the lists.`,
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
    if (list.about) lines.push(`  ${list.about}`)
    if (list.items.length === 0) lines.push('  (empty)')
    for (const item of list.items) {
      n++
      const glyph = GLYPH[item.status].replace(' ', ' ')
      lines.push(`  ${glyph} ${n}. ${item.text} (${item.id})${item.note ? ` — ${item.note}` : ''}`)
    }
  }
  return lines.join('\n')
}

function storeKey(sessionId: string): string {
  return `board:${sessionId}`
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

/** The band above the prompt depends on whether the pane is on screen, which no state read tracks. */
function redraw($: EngineInterface): void {
  $.ui.invalidate('ui.render')
}

async function commit($: EngineInterface, change: (todo: TodoBoard) => TodoBoard): Promise<TodoBoard> {
  const todo = await update($, board, change)
  await $.store.set(storeKey(await $.session.id()), todo)
  return todo
}

/**
 * Writes one of the plugin's options through its own /config row. The row's key carries the
 * plugin's loaded name, which differs by how it was loaded (`session-todo`, `session-todo@inline`,
 * `session-todo@<marketplace>`), so the row is found by its field rather than spelled out.
 * Resolves to the reason when the write did not happen.
 */
async function setOption($: EngineInterface, field: string, value: string | boolean): Promise<string | undefined> {
  const rows = await $.config.list()
  const row = rows.find(one => one.key === `session-todo.${field}` || /^session-todo@[^.]+\.(.+)$/.exec(one.key)?.[1] === field)
  if (!row) return `no "${field}" row in /config for this plugin (rows: ${rows.length})`
  try {
    const set = await $.config.set({ key: row.key, value })
    return set.deny
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function setTheme($: EngineInterface, name: string): Promise<string | undefined> {
  return setOption($, THEME_FIELD, name)
}

async function ensurePane($: EngineInterface): Promise<void> {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) await $.ui.open({ id: PANE, title: 'Todo' })
  redraw($)
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
      const about = aboutOf(input.about, existing?.about)
      const list: TodoList = { name: existing?.name ?? name, title: input.title ?? existing?.title ?? name, items }
      if (about) list.about = about
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
    case 'describe': {
      const target = targetList(todo, input.list)
      if (!target) return `no list named ${input.list ?? '(none)'}`
      const about = aboutOf(input.about, undefined)
      return {
        ...todo,
        lists: todo.lists.map(list => {
          if (list !== target) return list
          const changed: TodoList = { ...list }
          if (about) changed.about = about
          else delete changed.about
          return changed
        }),
      }
    }
    default:
      return `unknown action ${String((input as { action?: unknown }).action)}`
  }
}

/** The `about` a call leaves on a list: the given one trimmed, or the current one when none is given. */
function aboutOf(given: string | undefined, current: string | undefined): string | undefined {
  if (given === undefined) return current
  return given.trim().replace(/\s+/g, ' ') || undefined
}

/**
 * Cuts an `about` past the cap at a word boundary, with an ellipsis, and says so: the field is
 * optional, so a long one must never fail the call that carries it.
 */
function fitAbout(about: string | undefined): { about: string | undefined; note?: string } {
  if (about === undefined) return { about }
  const whole = about.trim().replace(/\s+/g, ' ')
  if (whole.length <= ABOUT_MAX) return { about: whole }
  const room = whole.slice(0, ABOUT_MAX - 1)
  const atWord = room.lastIndexOf(' ')
  const cut = `${(atWord > ABOUT_MAX / 2 ? room.slice(0, atWord) : room).trimEnd()}…`
  return { about: cut, note: `about was ${whole.length} characters and is cut to ${ABOUT_MAX}: "${cut}"` }
}

/** An item by its number in the pane (counted across lists in drawn order) or by id. */
function byNumber(todo: TodoBoard, arg: string): TodoItem | undefined {
  const items = drawn(todo).flatMap(list => list.items)
  const n = Number.parseInt(arg, 10)
  if (Number.isFinite(n) && n >= 1 && n <= items.length) return items[n - 1]
  return items.find(item => item.id === arg)
}

const USAGE = `Usage: /todo [add [@list] <text> | start <n> | done <n> | remove <n> | about <list> [text] | clear [list] | drop <list> | focus <list> | theme <${THEME_NAMES.join('|')}> | compact [on|off] | band [on|off]]`

export const register: Register = (on, options) => {
  const themeKey = themeName(options.theme)
  const isCompact = options.compact === true
  const hasBand = options.band !== false
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
      description: 'The session todo pane: /todo, add [@list] <text>, start <n>, done <n>, remove <n>, about <list> [text], clear [list], drop <list>, focus <list>, theme <name>, compact [on|off], band [on|off]',
      argumentHint: '[add [@list] <text> | start <n> | done <n> | remove <n> | about <list> [text] | clear [list] | drop <list> | focus <list> | theme <name> | compact [on|off] | band [on|off]]',
    })

    const saved = (await $.store.get(storeKey(await $.session.id()))) as TodoBoard | undefined
    if (saved && Array.isArray(saved.lists)) await update($, board, () => saved)

    void $.ui.open({ id: PANE, title: 'Todo' }).then(() => redraw($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, board, () => EMPTY)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind !== 'unload') redraw($)
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!hasBand || e.props.hasSurvey) return next(e)
    const todo = await read($, board)
    const items = allItems(todo)
    if (items.length === 0 || (await isPaneShown($))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const done = items.filter(item => item.status === 'done').length
    const current = items.filter(item => item.status === 'in_progress')
    const now =
      current.length === 0
        ? 'TODO: nothing in progress'
        : `TODO: ${current[0]?.text}${current.length > 1 ? ` (+${current.length - 1})` : ''}`

    return (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text wrap="truncate-end" color={current.length === 0 ? undefined : theme.status.in_progress} dimColor={current.length === 0}>
          {now}
        </Text>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Text color={theme.accent} dimColor={!theme.accent}>{`${done}/${items.length}`}</Text>
          <Button key="open-pane" label="Todo" onPress={() => void ensurePane($)} />
        </Box>
      </Box>
    )
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, PROMPT_SECTION] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as TodoToolInput
    const before = await read($, board)
    const fitted = fitAbout(input.about)
    const outcome = applyTool(before, { ...input, about: fitted.about })
    if (typeof outcome === 'string') return { deny: `todo: ${outcome}` }
    const after = outcome === before ? before : await commit($, () => outcome)
    if (input.action !== 'read') await ensurePane($)
    return { result: fitted.note ? `${render(after)}\n(${fitted.note})` : render(after) }
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
    if (verb === 'about') {
      const [list, ...words] = rest
      if (!list) return { text: 'Usage: /todo about <list> [text]  (no text clears it)' }
      const fitted = fitAbout(words.join(' '))
      const outcome = applyTool(todo, { action: 'describe', list, about: fitted.about })
      if (typeof outcome === 'string') return { text: outcome }
      const text = render(await commit($, () => outcome))
      return { text: fitted.note ? `${text}\n(${fitted.note})` : text }
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
    if (verb === 'compact' || verb === 'band') {
      const current = verb === 'compact' ? isCompact : hasBand
      const wanted = rest[0] === 'on' ? true : rest[0] === 'off' ? false : !current
      const failed = await setOption($, verb, wanted)
      const label = verb === 'compact' ? 'Compact rows' : 'Band above the prompt'
      return { text: failed ? `Could not set ${verb}: ${failed}` : `${label} ${wanted ? 'on' : 'off'}.` }
    }
    if (verb === 'theme') {
      const name = rest[0]
      if (!name || !THEMES[name]) return { text: `Themes: ${THEME_NAMES.join(', ')}` }
      const failed = await setTheme($, name)
      return { text: failed ? `Could not set the theme: ${failed}` : `Theme set to ${name}.` }
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

    // The bar sits in the title row, so it stays short: a sixth of the pane, between 8 and 18 cells.
    const barWidth = Math.max(4, Math.round(Math.min(18, Math.max(8, Math.round(e.props.bodyColumns / 6))) * (theme.barScale ?? 1)))
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
                onSelect={value =>
                  void setTheme($, value).then(failed => {
                    if (failed) $.ui.toast(`Could not set the theme: ${failed}`)
                  })
                }
              />
            )
          })()}
          <Button
            plain
            key="compact"
            label={`${isCompact ? GLYPH.done : GLYPH.pending} compact`}
            dimColor={!isCompact}
            onPress={() =>
              void setOption($, 'compact', !isCompact).then(failed => {
                if (failed) $.ui.toast(`Could not set compact: ${failed}`)
              })
            }
          />
          <Button
            plain
            key="band"
            label={`${hasBand ? GLYPH.done : GLYPH.pending} band`}
            dimColor={!hasBand}
            onPress={() =>
              void setOption($, 'band', !hasBand).then(failed => {
                if (failed) $.ui.toast(`Could not set band: ${failed}`)
              })
            }
          />
        </Box>
      )

    let n = 0
    return (
      <Box flexDirection="column" paddingX={1} minHeight={e.props.scroll.bodyRows}>
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
          return (
            <Box key={`list:${list.name}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Text bold color={theme.title} wrap="wrap">
                  {list.title}
                </Text>
                <Box flexDirection="row" gap={1} flexShrink={0}>
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
                    {list.items.length === 0 ? 'empty' : `${done}/${list.items.length}`}
                  </Text>
                </Box>
              </Box>
              <Box marginBottom={list.items.length === 0 ? 0 : 1}>
                {list.about && (
                  <Text dimColor italic wrap="wrap">
                    {list.about}
                  </Text>
                )}
              </Box>
              {list.items.map((item, index) => {
                n++
                return (
                  <Box key={`row:${item.id}`} flexDirection="column" marginTop={index === 0 || isCompact ? 0 : 1}>
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
                        color={item.status === 'done' || item.status === 'pending' ? undefined : theme.status[item.status]}
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
        <Box flexGrow={1} />
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {LEGEND}
          </Text>
        </Box>
      </Box>
    )
  })
}
