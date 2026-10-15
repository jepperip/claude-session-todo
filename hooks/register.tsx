import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { SharedBoard, TodoBoard, TodoItem, TodoList, TodoStatus } from '../types'

const PANE = 'session-todo'
const TOOL = 'mcp__session-todo__todo'
const COMMAND = 'todo'
const DEFAULT_LIST = 'main'
const EMPTY: TodoBoard = { lists: [], nextId: 1 }

const board = atom({ plugin: 'session-todo', key: 'board' } as const, EMPTY)
const settingsOpen = atom({ plugin: 'session-todo', key: 'settingsOpen' } as const, false)
const justDone = atom({ plugin: 'session-todo', key: 'justDone' } as const, null)
const paneAutoOpened = atom({ plugin: 'session-todo', key: 'paneAutoOpened' } as const, false)
const shared = atom({ plugin: 'session-todo', key: 'shared' } as const, null)
const bandOpen = atom({ plugin: 'session-todo', key: 'bandOpen' } as const, false)
const THEME_FIELD = 'theme'

/** How often a session following a shared board reads it back from the store for other sessions' writes. */
const POLL_MS = 2000
/** The longest label a session signs a shared board with. */
const LABEL_MAX = 20
/** How long a stored board may go without a write before a session start prunes it. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** How long the toast about an item waiting on the person stays; longer than the default, since it is the one thing not to miss. */
const TOAST_MS = 8000

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'blocked']

// The empty box holds a figure space (U+2007), as wide as a digit, so it lines up with [x] where a
// proportional font would draw a plain space narrower.
const GLYPH: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  done: '[x]',
  blocked: '[!]',
}

/** Follows the text of an item the agent does itself, so the person's own steps stand out by its absence. */
const AGENT_MARK = '✱'
/** Follows the text of an item the person does. */
const USER_MARK = '♟'
/** The marks' own colours, muted so they read as badges rather than status: orange for the agent, yellow for the person. */
const AGENT_MARK_COLOR = '#c97b4a'
const USER_MARK_COLOR = '#d4b24c'

/** The copy button at the end of each row while the pane holds the keyboard; a press puts the item's text and note on the clipboard. */
const COPY_MARK = '⧉'
const COPY_COLOR = '#777777'

const LEGEND = `${GLYPH.pending} pending  ${GLYPH.in_progress} in progress  ${GLYPH.done} done  ${GLYPH.blocked} blocked  ${AGENT_MARK} Claude's  ${USER_MARK} yours  · click a glyph to cycle, ${COPY_MARK} to copy`

/** The speech bubble and the figure under it, drawn at the bottom of the pane on Fridays. */
const FRIDAY_BUBBLE = ['╭──────────────────────╮', '│ have a nice weekend! │', '╰─┬────────────────────╯']
const FRIDAY_GUY = ['  ╯', ' \\o/🍺', '  |', ' / \\']

const FRIDAY = 5

/** Whether the given moment falls on a Friday where this module runs. */
function isFriday(epochMs: number): boolean {
  return new Date(epochMs).getDay() === FRIDAY
}

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
  action: 'write' | 'add' | 'update' | 'remove' | 'read' | 'clear' | 'drop' | 'focus' | 'describe' | 'join' | 'leave'
  list?: string
  title?: string
  about?: string
  items?: Array<{ id?: string; text: string; status?: TodoStatus; note?: string; owner?: TodoOwner }>
  id?: string
  text?: string
  status?: TodoStatus
  note?: string
  owner?: TodoOwner
  board?: string
  label?: string
}

/** The tool actions that change a board, as opposed to joining or leaving one. */
type TodoBoardInput = TodoToolInput & { action: Exclude<TodoToolInput['action'], 'join' | 'leave'> }

type TodoOwner = NonNullable<TodoItem['owner']>

const TOOL_DESCRIPTION = [
  'The todo lists the user watches in the Todo side pane. They are their view of the plan and of your progress, so keep them current without being asked, also when you do every step yourself.',
  'Lists are named (default "main"); items are addressed by id, unique across lists.',
  '- write: replace one list with its steps (list, title, items, optional about). Do this before the first edit, command or search of any task that takes more than one tool call or spans more than one turn; only a single edit or a question answered from memory needs no list. The first list written becomes the active one, drawn first; focus switches it.',
  '- board (with write): a short name for the whole board, letters, digits, _ and -, such as the ticket or the feature (DAN-1234, release-notes). Give it with the first write of a plan: the pane shares the board under that name with one click. Lists are many, so the board\'s name is its own.',
  `- about (optional, one line of at most ${ABOUT_MAX} characters; a longer one is cut with an ellipsis): one short sentence under the title saying what the list is for or what done looks like, so the user still knows a day later. Not a summary of the items. Set it with write and leave it; describe changes it later.`,
  '- add / update / remove: one item. Mark the step you begin in_progress (prefer one at a time, several when work really runs in parallel), done the moment it finishes, blocked with a note when it waits on the user.',
  '- owner: who does the item, "agent" (you; the default) or "user". Mark a step "user" when only the person can take it: approve, decide, click, run something you may not. The pane marks your own items so theirs stand out.',
  '- read: every list as the pane shows it, with ids. Call it after a context compaction.',
  '- clear: empty one list (list) or all. drop: remove a list. focus: make a list the active one. describe: set or clear a list\'s about (list, about).',
  'Use a second list, e.g. "followup", for things to do after the main work (open the PR, report a finding to Jira), so the main list stays focused.',
  'Keep item text short and imperative, one line each. Before reporting a task finished, leave its list true: every item done, items that fell away removed.',
  '- join (board, optional label): follow a board shared by another session instead of this session\'s own; leave: back to this session\'s own board. The person usually does this with /todo share and /todo join; call join only when they ask for it.',
  'On a shared board (the result says so) other sessions write too: add your items with add or write a list of your own, report progress with update, and never write a list you did not create, since write replaces its items.',
].join('\n')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['write', 'add', 'update', 'remove', 'read', 'clear', 'drop', 'focus', 'describe', 'join', 'leave'] },
    board: { type: 'string', description: 'With write: a short name for the whole board (letters, digits, _ and -), the name it is shared under. With join: the shared board to follow.' },
    label: { type: 'string', description: `What this session signs its changes on the shared board with (join); at most ${LABEL_MAX} characters.` },
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
          owner: { type: 'string', enum: ['agent', 'user'] },
        },
        required: ['text'],
      },
    },
    id: { type: 'string', description: 'The item (update, remove).' },
    text: { type: 'string', description: 'The item text (add, update).' },
    status: { type: 'string', enum: STATUSES, description: 'The new status (add, update).' },
    note: { type: 'string', description: 'A short note on the item, e.g. why it is blocked (add, update). Empty removes it.' },
    owner: { type: 'string', enum: ['agent', 'user'], description: 'Who does the item (add, update): agent (default) or user.' },
  },
  required: ['action'],
}

const PROMPT_SECTION = {
  id: 'session-todo:instructions',
  scope: 'session',
  text: [
    '# Session todo pane',
    `The person watches a live todo pane driven by the \`${TOOL}\` tool. It is how they follow your progress while you work, also when every step is yours and they take none, so a list is wanted whenever the work is more than a moment's.`,
    '',
    '- Before the first edit, command or search of any task that takes more than one tool call, or that spans more than one turn, write the list (action write): the steps as you see them, one short imperative line each. One write is cheap; work the person could not follow is not. Skip it only for a single edit or a question answered from what you already know.',
    '- Give the board a short name with that first write (board: the ticket or the feature, letters, digits, _ and -). The pane shares the board under it with one click, so other sessions can join the plan.',
    '- Caught mid-task without a list? Write it now, with the finished steps already marked done.',
    '- Mark the step you begin in_progress (one at a time; several only when work really runs in parallel), done the moment it finishes, blocked with a note when it waits on the person.',
    '- Add and remove items as the work changes. Keep follow-ups (open the PR, report to Jira, update docs) in a second list so the main plan stays focused.',
    '- A list may carry an optional about: one short sentence on what it is for, set when the list is written and then left alone.',
    '- Before reporting a task finished, leave its list true: every item done, items that fell away removed. A stale list is worse than none.',
    '- After a context compaction, call read to recover the lists.',
    '- A shared board (the person joined one with /todo share or /todo join; every tool result then says so) is written by other sessions too: add your items with add or in a list of your own, report progress with update, and never write a list you did not create, since write replaces its items.',
    '- When the person changes the board themselves (a click in the pane, a /todo command), a short "session-todo:" note tells you so. It needs no reply; take it into account when it changes your next step, for instance an item of yours they marked done or one they added.',
  ].join('\n'),
} as const

/** The words a note to the model uses for a status the person set. */
const STATUS_WORD: Record<TodoStatus, string> = { pending: 'pending again', in_progress: 'in progress', done: 'done', blocked: 'blocked' }

/**
 * Tells the model what the person just did to the board: a user-role row they do not see typed,
 * read on the model's next step, so a tick in the pane reaches the agent without a prompt.
 */
async function tell($: EngineInterface, what: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `session-todo: the person ${what}` }] } })
}

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

/**
 * The items the person has to act on now: every blocked one (the agent marks a step blocked when
 * it waits on them), and their own that are up: in progress, or next when nothing is in progress.
 */
function waitingOnYou(todo: TodoBoard): TodoItem[] {
  const items = allItems(todo)
  const waiting = items.filter(item => item.status === 'blocked' || (item.owner === 'user' && item.status === 'in_progress'))
  if (!items.some(item => item.status === 'in_progress')) {
    const next = items.find(item => item.status === 'pending')
    if (next?.owner === 'user') waiting.push(next)
  }
  return waiting
}

/** Whether a toast names an item that starts waiting on the person; set from the plugin's options on load. */
let notifies = true

/**
 * Toasts the person when an item starts waiting on them between two states of the board, once
 * per item, unless turned off. The band and the pane show the item in their colour either way.
 */
function pokeFor($: EngineInterface, before: TodoBoard, after: TodoBoard): void {
  if (!notifies) return
  const was = new Set(waitingOnYou(before).map(item => item.id))
  const fresh = waitingOnYou(after).filter(item => !was.has(item.id))
  const first = fresh[0]
  if (!first) return
  $.ui.toast(`${USER_MARK} needs you: ${first.text}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`, { timeoutMs: TOAST_MS })
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

function render(todo: TodoBoard, following?: SharedBoard | null): string {
  const lines: string[] = following
    ? [`Shared board "${following.name}" (this session signs as "${following.label}"): other sessions write here too; add and update, never write over their lists.`]
    : todo.name
      ? [`Board "${todo.name}" (shareable under that name)`]
      : []
  if (todo.lists.length === 0) return [...lines, 'Todo: no lists'].join('\n')
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
      const owner = item.owner === 'user' ? ' [yours]' : ''
      const by = item.by ? ` @${item.by}` : ''
      lines.push(`  ${glyph} ${n}. ${item.text} (${item.id})${owner}${by}${item.note ? ` — ${item.note}` : ''}`)
    }
  }
  return lines.join('\n')
}

function storeKey(sessionId: string): string {
  return `board:${sessionId}`
}

/** Where a session records the shared board it follows, so a resume follows it again. */
function followKey(sessionId: string): string {
  return `follow:${sessionId}`
}

const SHARED_PREFIX = 'shared:'

function sharedKey(name: string): string {
  return `${SHARED_PREFIX}${name}`
}

function asBoard(value: unknown): TodoBoard | undefined {
  const held = value as TodoBoard | undefined
  return held && Array.isArray(held.lists) ? held : undefined
}

async function loadShared($: EngineInterface, name: string): Promise<TodoBoard | undefined> {
  return asBoard(await $.store.get(sharedKey(name)))
}

function stamped(todo: TodoBoard, now: number): TodoBoard {
  return { ...todo, updatedAt: now }
}

function ago(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

const MIRROR_PREFIX = 'board:'

/**
 * Drops the boards nobody has written for KEEP_MS: other sessions' mirrors (with the shared
 * board they followed) and shared boards. This session's own mirror and the board it follows
 * are stamped instead; a board from before the stamps gets one now, so it ages from here.
 */
async function prune($: EngineInterface, sessionId: string, followed: string | undefined): Promise<void> {
  const now = await $.clock.now()
  const kept = new Set([storeKey(sessionId), ...(followed ? [sharedKey(followed)] : [])])
  for (const key of await $.store.keys()) {
    const isMirror = key.startsWith(MIRROR_PREFIX)
    if (!isMirror && !key.startsWith(SHARED_PREFIX)) continue
    const held = asBoard(await $.store.get(key))
    if (!held) continue
    if (kept.has(key) || held.updatedAt === undefined) {
      await $.store.set(key, stamped(held, now))
      continue
    }
    if (now - held.updatedAt <= KEEP_MS) continue
    await $.store.delete(key)
    if (isMirror) await $.store.delete(followKey(key.slice(MIRROR_PREFIX.length)))
  }
}

/** Signs the items this session created or moved on a shared board, so every session sees who did what. */
function signed(next: TodoBoard, base: TodoBoard, label: string): TodoBoard {
  const was = new Map(allItems(base).map(item => [item.id, item]))
  return {
    ...next,
    lists: next.lists.map(list => ({
      ...list,
      items: list.items.map(item => {
        const before = was.get(item.id)
        return before && before.status === item.status ? item : { ...item, by: label }
      }),
    })),
  }
}

/** The label a session signs a shared board with: the one given, else the start of its id. */
function labelOf(given: string | undefined, sessionId: string): string {
  const label = (given ?? '').trim().replace(/\s+/g, ' ')
  return (label || sessionId.slice(0, 6)).slice(0, LABEL_MAX)
}

/** `<name> [as <label>]`, as /todo share and /todo join take it. */
function nameAndLabel(words: string[]): { name: string | undefined; label: string | undefined } {
  const at = words.indexOf('as')
  return { name: words[0], label: at > 0 ? words.slice(at + 1).join(' ') : undefined }
}

/** The poll of the shared board; a hot reload cancels it, and session.start arms it again. */
let polling: Timer | undefined

/** Reads the shared board back from the store and redraws when another session changed it. */
async function pull($: EngineInterface, name: string): Promise<void> {
  const fresh = await loadShared($, name)
  if (!fresh) return
  const held = await read($, board)
  if (JSON.stringify(fresh) === JSON.stringify(held)) return
  await update($, board, () => fresh)
  pokeFor($, held, fresh)
}

async function follow($: EngineInterface, following: SharedBoard, todo: TodoBoard): Promise<void> {
  await $.store.set(followKey(await $.session.id()), following)
  await update($, shared, () => following)
  await update($, board, () => todo)
  polling?.cancel()
  polling = $.clock.every(POLL_MS, () => void pull($, following.name))
}

/** Back to this session's own board, left as it was when the shared one was joined. */
async function unfollow($: EngineInterface): Promise<void> {
  polling?.cancel()
  polling = undefined
  const sessionId = await $.session.id()
  await $.store.delete(followKey(sessionId))
  await update($, shared, () => null)
  const own = asBoard(await $.store.get(storeKey(sessionId))) ?? EMPTY
  await update($, board, () => own)
}

type Joined = { todo: TodoBoard; following: SharedBoard }

async function joinBoard($: EngineInterface, name: string | undefined, label: string | undefined): Promise<Joined | string> {
  if (!name || !isValidName(name)) return `board names are letters, digits, _ and -: ${name ?? '(none)'}`
  const todo = await loadShared($, name)
  if (!todo) return `no shared board named ${name}; /todo share ${name} creates it from a session's own board`
  const following = { name, label: labelOf(label, await $.session.id()) }
  await follow($, following, todo)
  await openPane($)
  return { todo, following }
}

/** Publishes this session's own board, under the given name or the board's own, and follows it. */
async function shareBoard($: EngineInterface, given: string | undefined, label: string | undefined): Promise<Joined | string> {
  const current = await read($, shared)
  if (current) return `this session already follows the shared board ${current.name}; /todo leave first`
  const own = await read($, board)
  const name = given ?? own.name
  if (!name) return 'the board has no name yet: /todo share <name>, or /todo name <name> first'
  if (!isValidName(name)) return `board names are letters, digits, _ and -: ${name}`
  if (await loadShared($, name)) return `a shared board named ${name} exists; /todo join ${name} follows it`
  const todo = stamped({ ...own, name }, await $.clock.now())
  await $.store.set(sharedKey(name), todo)
  const following = { name, label: labelOf(label, await $.session.id()) }
  await follow($, following, todo)
  await openPane($)
  return { todo, following }
}

async function leaveBoard($: EngineInterface): Promise<string> {
  const following = await read($, shared)
  if (!following) return 'This session follows no shared board.'
  await unfollow($)
  return `Left the shared board ${following.name}; back to this session's own board.`
}

async function sharedBoards($: EngineInterface): Promise<string> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(SHARED_PREFIX))
  if (keys.length === 0) return "No shared boards. /todo share <name> shares this session's board."
  const following = await read($, shared)
  const now = await $.clock.now()
  const lines: string[] = []
  for (const key of keys) {
    const name = key.slice(SHARED_PREFIX.length)
    const held = asBoard(await $.store.get(key)) ?? EMPTY
    const items = allItems(held)
    const done = items.filter(item => item.status === 'done').length
    const changed = held.updatedAt === undefined ? '' : `, last change ${ago(now - held.updatedAt)}`
    lines.push(`${name}${following?.name === name ? ' (following)' : ''}: ${done}/${items.length} done${changed}`)
  }
  return [...lines, `Boards with no change for ${KEEP_MS / (24 * 60 * 60 * 1000)} days are dropped when a session starts; /todo forget <name> drops one now.`].join('\n')
}

async function forgetBoard($: EngineInterface, name: string | undefined): Promise<string> {
  if (!name) return 'Usage: /todo forget <name>'
  if ((await read($, shared))?.name === name) return `This session follows ${name}; /todo leave first.`
  if (!(await loadShared($, name))) return `No shared board named ${name}.`
  await $.store.delete(sharedKey(name))
  return `Forgot the shared board ${name}. A session still following it keeps what it holds and writes it back on its next change.`
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

async function isPaneFocused($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isFocused)
}

/** How often the pane's focus is read back, since no event says when a click gives it the keyboard. */
const FOCUS_POLL_MS = 300
let focusWatch: Timer | undefined
let wasFocused = false

/**
 * Redraws the pane when it gains or loses the keyboard. On the desktop a click on an unfocused
 * pane only focuses it, so the copy buttons are drawn only while a click would reach them.
 */
function watchFocus($: EngineInterface): void {
  focusWatch?.cancel()
  focusWatch = $.clock.every(FOCUS_POLL_MS, () => {
    void isPaneFocused($).then(focused => {
      if (focused === wasFocused) return
      wasFocused = focused
      redraw($)
    })
  })
}

/** The band above the prompt depends on whether the pane is on screen, which no state read tracks. */
function redraw($: EngineInterface): void {
  $.ui.invalidate('ui.render')
}

/** How long the band shows an item that just finished before moving on to the next one. */
const JUST_DONE_MS = 2000

/**
 * Applies a change and persists the board: the session's own in its store slot, or the shared
 * one, re-read from the store first so that what other sessions wrote since the last poll is
 * kept under the change. Resolves to the change's refusal when it gives one. A change the
 * person made themselves (a command, a click) never pokes them about what it put up next.
 */
async function commit($: EngineInterface, change: (todo: TodoBoard) => TodoBoard | string, byPerson = false): Promise<TodoBoard | string> {
  const following = await read($, shared)
  const held = await read($, board)
  const base = following ? ((await loadShared($, following.name)) ?? held) : held
  const changed = change(base)
  if (typeof changed === 'string') return changed
  if (changed === base) {
    if (base !== held) await update($, board, () => base)
    return base
  }
  const todo = stamped(following ? signed(changed, base, following.label) : changed, await $.clock.now())
  await update($, board, () => todo)
  await $.store.set(following ? sharedKey(following.name) : storeKey(await $.session.id()), todo)

  const before = allItems(held)
  const finished = allItems(todo).find(item => {
    const was = before.find(one => one.id === item.id)
    return was?.status === 'in_progress' && item.status === 'done'
  })
  if (finished) {
    await update($, justDone, () => ({ id: finished.id, text: finished.text }))
    $.clock.after(JUST_DONE_MS, () => void update($, justDone, held => (held?.id === finished.id ? null : held)))
  }
  if (!byPerson) pokeFor($, held, todo)
  return todo
}

/**
 * Writes one of the plugin's options through its own /config row. The row's key carries the
 * plugin's loaded name, which differs by how it was loaded (`session-todo`, `session-todo@inline`,
 * `session-todo@<marketplace>`), so the row is found by its field rather than spelled out.
 * Resolves to the reason when the write did not happen.
 */
async function setOption($: EngineInterface, field: string, value: string | boolean): Promise<string | undefined> {
  // The rows are cached across a hot reload of this plugin, so a field the manifest gained since
  // the session started is missing from them until the cache is dropped.
  const isOwn = (key: string) => key === `session-todo.${field}` || /^session-todo@[^.]+\.(.+)$/.exec(key)?.[1] === field
  let rows = await $.config.list()
  if (!rows.some(one => isOwn(one.key))) {
    $.ui.invalidate('config.describe')
    rows = await $.config.list()
  }
  const row = rows.find(one => isOwn(one.key))
  if (!row) return `no "${field}" row in /config for this plugin (rows: ${rows.length}); a restart of Claude Code lists it`
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

/** Opens the pane because the person asked: a command, a button on the band. */
async function openPane($: EngineInterface): Promise<void> {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) await $.ui.open({ id: PANE, title: 'Todo' })
  await update($, paneAutoOpened, () => true)
  redraw($)
}

/**
 * Opens the pane on the agent's behalf, once per session at most: the first write brings it up,
 * and after that a pane the person closed stays closed, with the band standing in for it. In the
 * band-only layout the pane opens only when the person asks for it.
 */
async function autoOpenPane($: EngineInterface): Promise<void> {
  if (layout === 'band') return
  if (await read($, paneAutoOpened)) return
  await openPane($)
}

function applyTool(todo: TodoBoard, input: TodoBoardInput): TodoBoard | string {
  switch (input.action) {
    case 'read':
      return todo
    case 'write': {
      const name = input.list ?? todo.active ?? DEFAULT_LIST
      if (!isValidName(name)) return `list names are letters, digits, _ and -: ${name}`
      if (input.board !== undefined && !isValidName(input.board)) return `board names are letters, digits, _ and -: ${input.board}`
      const boardName = input.board ?? todo.name
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
        const item: TodoItem = { id, text: given.text, status: given.status ?? 'pending', owner: given.owner ?? 'agent' }
        if (given.note) item.note = given.note
        items.push(item)
      }
      const about = aboutOf(input.about, existing?.about)
      const list: TodoList = { name: existing?.name ?? name, title: input.title ?? existing?.title ?? name, items }
      if (about) list.about = about
      const lists = existing ? todo.lists.map(one => (one === existing ? list : one)) : [...todo.lists, list]
      const written: TodoBoard = { lists, active: todo.active ?? list.name, nextId }
      if (boardName) written.name = boardName
      return written
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
      const item: TodoItem = { id: `t${todo.nextId}`, text: input.text, status: input.status ?? 'pending', owner: input.owner ?? 'agent' }
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
        if (input.owner) changed.owner = input.owner
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

/**
 * What shows where: `auto` (the band while the pane is closed; the pane opens on its own at the
 * first items), `both` (the band always, the pane as in auto), `band` (the band always, the pane
 * only when asked for), `pane` (no band, the pane as in auto).
 */
type Layout = 'auto' | 'both' | 'band' | 'pane'
const LAYOUTS: readonly Layout[] = ['auto', 'both', 'band', 'pane']
const LAYOUT_LABELS: Record<Layout, string> = { auto: 'auto', both: 'band and pane', band: 'band only', pane: 'pane only' }
/** The band setting the layout replaced: its modes, and the switch it was before that, map onto layouts. */
const OLD_BAND: Record<string, Layout> = { off: 'pane', closed: 'auto', always: 'both' }

function layoutOf(value: unknown, oldBand?: unknown): Layout {
  if (typeof value === 'string' && (LAYOUTS as readonly string[]).includes(value)) return value as Layout
  if (oldBand === false) return 'pane'
  if (typeof oldBand === 'string' && oldBand in OLD_BAND) return OLD_BAND[oldBand] as Layout
  return 'auto'
}

/** The layout in force; set from the plugin's options on load. */
let layout: Layout = 'auto'

type BoardElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
/** `canCopy`: whether to draw the copy button on each row; only while the site holds the keyboard, since a click on an unfocused pane only focuses it. */
type BoardDrawing = { theme: Theme; isCompact: boolean; bodyColumns: number; canCopy: boolean }

/**
 * The lists with their items, and the block under them (the items needing the person, the ones
 * in progress), as both the pane and the unfolded band draw them. A glyph click cycles the item.
 */
function drawBoard($: EngineInterface, ui: BoardElements, todo: TodoBoard, { theme, isCompact, bodyColumns, canCopy }: BoardDrawing) {
  const { Box, Text, Button } = ui
  const lists = drawn(todo)
  const current = lists.flatMap(list => list.items).filter(item => item.status === 'in_progress')
  const waiting = waitingOnYou(todo)
  // The bar sits in the title row, so it stays short: a sixth of the width, between 8 and 18 cells.
  const barWidth = Math.max(4, Math.round(Math.min(18, Math.max(8, Math.round(bodyColumns / 6))) * (theme.barScale ?? 1)))
  const toggle = (item: TodoItem) => () => {
    const status = nextStatus(item.status)
    void commit($, todo => mapItem(todo, item.id, one => ({ ...one, status })), true).then(outcome => {
      if (typeof outcome !== 'string') void tell($, `marked "${item.text}" (${item.id}) ${STATUS_WORD[status]} in the pane.`)
    })
  }

  let n = 0
  return [
    ...(lists.length === 0
      ? [
          <Text key="empty" dimColor wrap="wrap">
            Nothing planned yet. The agent fills this in as work is planned; /todo add adds your own.
          </Text>,
        ]
      : []),
    ...lists.map((list, index) => {
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
              <Text bold={done === list.items.length && done > 0} dimColor={done !== list.items.length && !theme.accent} color={theme.accent}>
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
                  <Button plain key={`toggle:${item.id}`} label={GLYPH[item.status]} dimColor={item.status === 'done'} onPress={toggle(item)} />
                  <Text
                    wrap="wrap"
                    bold={item.status === 'in_progress'}
                    dimColor={item.status === 'done'}
                    strikethrough={item.status === 'done'}
                    color={item.status === 'done' || item.status === 'pending' ? undefined : theme.status[item.status]}
                  >
                    {`${n}. ${item.text}`}
                  </Text>
                  <Text color={item.owner === 'user' ? USER_MARK_COLOR : AGENT_MARK_COLOR} dimColor={item.status === 'done'}>
                    {item.owner === 'user' ? USER_MARK : AGENT_MARK}
                  </Text>
                  {item.by && <Text dimColor>{`@${item.by}`}</Text>}
                  {canCopy && (
                    <Button
                      plain
                      key={`copy:${item.id}`}
                      onPress={press => {
                        const text = item.note ? `${item.text}\r\n${item.note}` : item.text
                        void $.ui
                          .copy({ text, surface: press.surface })
                          .then(copied => $.ui.toast(copied.isCopied ? 'Copied to clipboard' : `Could not copy: ${copied.reason}`))
                      }}
                    >
                      <Text color={COPY_COLOR}>{COPY_MARK}</Text>
                    </Button>
                  )}
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
    }),
    ...(waiting.length > 0 || current.length > 0
      ? [
          <Box key="now" flexDirection="column" marginTop={1}>
            {waiting.map(item => (
              <Text key={`you:${item.id}`} bold color={USER_MARK_COLOR} wrap="wrap">
                {`${USER_MARK} needs you: ${item.text}${item.note ? ` — ${item.note}` : ''}`}
              </Text>
            ))}
            {current
              .filter(item => !waiting.includes(item))
              .map(item => (
                <Text key={`now:${item.id}`} dimColor={!theme.accent} color={theme.accent} wrap="wrap">
                  {`now: ${item.text}`}
                </Text>
              ))}
          </Box>,
        ]
      : []),
  ]
}

const USAGE = `Usage: /todo [add [@list] <text> | start <n> | done <n> | remove <n> | about <list> [text] | clear [list] | drop <list> | focus <list> | name <name> | share [name] [as <label>] | join <name> [as <label>] | leave | boards | forget <name> | theme <${THEME_NAMES.join('|')}> | layout [${LAYOUTS.join('|')}] | compact [on|off] | notify [on|off]]`

export const register: Register = (on, options) => {
  const themeKey = themeName(options.theme)
  const isCompact = options.compact === true
  layout = layoutOf(options.layout, (options as Record<string, unknown>).band)
  notifies = options.notify !== false
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
      description: 'The session todo pane: /todo, add [@list] <text>, start <n>, done <n>, remove <n>, about <list> [text], clear [list], drop <list>, focus <list>, name <name>, share [name], join <name>, leave, boards, forget <name>, theme <name>, layout [auto|both|band|pane], compact [on|off], notify [on|off]',
      argumentHint: '[add [@list] <text> | start <n> | done <n> | remove <n> | about <list> [text] | clear [list] | drop <list> | focus <list> | name <name> | share [name] [as <label>] | join <name> [as <label>] | leave | boards | forget <name> | theme <name> | layout [auto|both|band|pane] | compact [on|off] | notify [on|off]]',
    })

    const sessionId = await $.session.id()
    const following = (await $.store.get(followKey(sessionId))) as SharedBoard | undefined
    const saved = following?.name ? await loadShared($, following.name) : asBoard(await $.store.get(storeKey(sessionId)))
    if (following?.name) await follow($, following, saved ?? EMPTY)
    else if (saved) await update($, board, () => saved)
    await prune($, sessionId, following?.name)
    watchFocus($)

    // The pane opens on its own only when there is something to show: a restored board with
    // items. Otherwise the first write (the agent's or /todo add) opens it.
    if (saved && allItems(saved).length > 0) void autoOpenPane($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear empties this session's board and never a shared one: the session leaves it instead.
    if (e.reason === 'clear') {
      if (await read($, shared)) await unfollow($)
      await update($, board, () => EMPTY)
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind !== 'unload') redraw($)
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (layout === 'pane' || e.props.hasSurvey) return next(e)
    const todo = await read($, board)
    const items = allItems(todo)
    if (items.length === 0 || (layout === 'auto' && (await isPaneShown($)))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const done = items.filter(item => item.status === 'done').length
    const current = items.filter(item => item.status === 'in_progress')
    // With nothing in progress the band names the next pending item, so a freshly added item
    // shows up at once; with nothing pending either, it says so.
    const upcoming = current.length === 0 ? items.find(item => item.status === 'pending') : undefined
    const now =
      current.length > 0
        ? `TODO: ${current[0]?.text}${current.length > 1 ? ` (+${current.length - 1})` : ''}`
        : upcoming
          ? `TODO: ${upcoming.text}`
          : 'TODO: nothing left'

    const isIdle = current.length === 0 && upcoming === undefined
    // An item that just went from in progress to done holds the band for a moment, ticked, before
    // the next item takes its place.
    const finished = await read($, justDone)
    // Otherwise an item waiting on the person takes the band over everything else, in their colour.
    const waiting = waitingOnYou(todo)
    const you = finished ? undefined : waiting[0]
    const glyph = finished ? GLYPH.done : you ? GLYPH[you.status] : current.length > 0 ? GLYPH.in_progress : GLYPH.pending
    const glyphColor = finished
      ? theme.status.done
      : you
        ? you.status === 'pending'
          ? undefined
          : theme.status[you.status]
        : current.length > 0
          ? theme.status.in_progress
          : undefined
    const label = finished
      ? `DONE: ${finished.text}`
      : you
        ? `${you.text}${waiting.length > 1 ? ` (+${waiting.length - 1})` : ''}`
        : now
    // The ▸ unfolds the whole board under the row, as the pane draws it; the engine scrolls a
    // tall one in its window. The fold is remembered for the session.
    const isOpen = await read($, bandOpen)
    const fold = () => void update($, bandOpen, open => !open)
    // The glyph is the shown item's own toggle, as in the pane: a click cycles its status.
    const shown = (finished ? itemById(todo, finished.id) : undefined) ?? you ?? current[0] ?? upcoming
    const cycle = (item: TodoItem) => () => {
      const status = nextStatus(item.status)
      void commit($, todo => mapItem(todo, item.id, one => ({ ...one, status })), true).then(outcome => {
        if (typeof outcome !== 'string') void tell($, `marked "${item.text}" (${item.id}) ${STATUS_WORD[status]} on the band.`)
      })
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexDirection="row" gap={1} minWidth={0} flexShrink={1} overflow="hidden">
            {/* The desktop draws a button's text in its own style, so the coloured moments (the
                green tick, the idle grey) are plain text; a button only where a click does something. */}
            {shown && !finished ? (
              <Button plain key={`band-toggle:${shown.id}`} label={glyph} onPress={cycle(shown)} />
            ) : (
              <Text bold color={glyphColor} dimColor={isIdle && !finished}>
                {glyph}
              </Text>
            )}
            {you && <Text bold color={USER_MARK_COLOR}>TODO YOU:</Text>}
            {finished ? (
              <Text color={theme.status.done} wrap="truncate-end">
                {label}
              </Text>
            ) : isIdle && !you ? (
              <Text wrap="truncate-end" dimColor>
                {label}
              </Text>
            ) : (
              <Box minWidth={0} flexShrink={1} overflow="hidden">
                <Button plain key="open-current" label={label} onPress={fold} />
              </Box>
            )}
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text color={theme.accent} dimColor={!theme.accent}>{`${done}/${items.length}`}</Text>
            <Button key="open-pane" label="Open Pane" onPress={() => void openPane($)} />
            <Button plain key="fold" label={isOpen ? '▾' : '▸'} onPress={fold} />
          </Box>
        </Box>
        {isOpen && (
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            {drawBoard($, { Box, Text, Button }, todo, { theme, isCompact, bodyColumns: Math.max(20, e.props.bodyColumns - 2), canCopy: false })}
          </Box>
        )}
      </Box>
    )
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, PROMPT_SECTION] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as TodoToolInput
    if (input.action === 'join') {
      const joined = await joinBoard($, input.board, input.label)
      return typeof joined === 'string' ? { deny: `todo: ${joined}` } : { result: render(joined.todo, joined.following) }
    }
    if (input.action === 'leave') return { result: await leaveBoard($) }
    const action = input.action
    const fitted = fitAbout(input.about)
    const outcome = await commit($, todo => applyTool(todo, { ...input, action, about: fitted.about }))
    if (typeof outcome === 'string') return { deny: `todo: ${outcome}` }
    if (action !== 'read') await autoOpenPane($)
    const text = render(outcome, await read($, shared))
    return { result: fitted.note ? `${text}\n(${fitted.note})` : text }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const todo = await read($, board)
    const following = await read($, shared)
    const shown = (outcome: TodoBoard | string) => ({ text: typeof outcome === 'string' ? outcome : render(outcome, following) })

    if (verb === '') {
      await openPane($)
      return { text: render(todo, following) }
    }
    if (verb === 'add') {
      const list = rest[0]?.startsWith('@') ? rest.shift()?.slice(1) : undefined
      const text = rest.join(' ')
      if (!text) return { text: 'Usage: /todo add [@list] <text>' }
      const outcome = await commit($, todo => applyTool(todo, { action: 'add', list, text, owner: 'user' }), true)
      if (typeof outcome !== 'string') {
        await openPane($)
        await tell($, `added "${text}" to the ${list ?? outcome.active ?? DEFAULT_LIST} list as their own item.`)
      }
      return shown(outcome)
    }
    if (verb === 'clear' || verb === 'drop' || verb === 'focus') {
      const outcome = await commit($, todo => applyTool(todo, { action: verb, list: rest[0] }), true)
      if (typeof outcome !== 'string' && verb !== 'focus') await tell($, verb === 'clear' ? `cleared the ${rest[0] ?? 'whole'} list.` : `dropped the ${rest[0]} list.`)
      return shown(outcome)
    }
    if (verb === 'about') {
      const [list, ...words] = rest
      if (!list) return { text: 'Usage: /todo about <list> [text]  (no text clears it)' }
      const fitted = fitAbout(words.join(' '))
      const outcome = await commit($, todo => applyTool(todo, { action: 'describe', list, about: fitted.about }), true)
      const { text } = shown(outcome)
      return { text: fitted.note && typeof outcome !== 'string' ? `${text}\n(${fitted.note})` : text }
    }
    if (verb === 'start' || verb === 'done' || verb === 'remove') {
      const arg = rest.join(' ')
      const target = byNumber(todo, arg)
      if (!target) return { text: `No item ${arg || '(none)'}. Items are numbered as the pane shows them.` }
      const status: TodoStatus = verb === 'start' ? 'in_progress' : 'done'
      const outcome = await commit(
        $,
        todo => applyTool(todo, verb === 'remove' ? { action: 'remove', id: target.id } : { action: 'update', id: target.id, status }),
        true,
      )
      if (typeof outcome !== 'string') {
        await tell($, verb === 'remove' ? `removed "${target.text}" (${target.id}) from the list.` : `marked "${target.text}" (${target.id}) ${STATUS_WORD[status]}.`)
      }
      return shown(outcome)
    }
    if (verb === 'share' || verb === 'join') {
      const { name, label } = nameAndLabel(rest)
      const outcome = verb === 'share' ? await shareBoard($, name, label) : await joinBoard($, name, label)
      return { text: typeof outcome === 'string' ? outcome : render(outcome.todo, outcome.following) }
    }
    if (verb === 'leave') return { text: await leaveBoard($) }
    if (verb === 'name') {
      const name = rest[0]
      if (!name) return { text: todo.name ? `The board is named ${todo.name}.` : 'Usage: /todo name <name>' }
      if (following) return { text: `This session follows the shared board ${following.name}, which keeps its name.` }
      return shown(await commit($, todo => (isValidName(name) ? { ...todo, name } : `board names are letters, digits, _ and -: ${name}`), true))
    }
    if (verb === 'boards') return { text: await sharedBoards($) }
    if (verb === 'forget') return { text: await forgetBoard($, rest[0]) }
    if (verb === 'compact') {
      const wanted = rest[0] === 'on' ? true : rest[0] === 'off' ? false : !isCompact
      const failed = await setOption($, 'compact', wanted)
      return { text: failed ? `Could not set compact: ${failed}` : `Compact rows ${wanted ? 'on' : 'off'}.` }
    }
    if (verb === 'notify') {
      const wanted = rest[0] === 'on' ? true : rest[0] === 'off' ? false : !notifies
      const failed = await setOption($, 'notify', wanted)
      return { text: failed ? `Could not set notify: ${failed}` : `Toast when an item needs you: ${wanted ? 'on' : 'off'}. The band and the pane show it either way.` }
    }
    if (verb === 'layout' || verb === 'band') {
      // Without an argument the layouts cycle; the old band words still land on their layout.
      const given = rest[0]
      const wanted: Layout | undefined =
        given === undefined
          ? (LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length] ?? 'auto')
          : (LAYOUTS as readonly string[]).includes(given)
            ? (given as Layout)
            : given === 'on'
              ? 'auto'
              : OLD_BAND[given]
      if (!wanted) return { text: `Layouts: ${LAYOUTS.map(one => `${one} (${LAYOUT_LABELS[one]})`).join(', ')}` }
      const failed = await setOption($, 'layout', wanted)
      return { text: failed ? `Could not set the layout: ${failed}` : `Layout: ${LAYOUT_LABELS[wanted]}.` }
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
    const isSettingsOpen = await read($, settingsOpen)
    const following = await read($, shared)
    const friday = isFriday(await $.clock.now())
    const isFocused = await isPaneFocused($)

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
          <Text dimColor>Layout</Text>
          {(() => {
            const { Select } = $.ui.resolve(e)
            return (
              <Select
                key="layout"
                value={layout}
                options={LAYOUTS.map(one => ({ value: one, label: LAYOUT_LABELS[one] }))}
                onSelect={value =>
                  void setOption($, 'layout', value).then(failed => {
                    if (failed) $.ui.toast(`Could not set the layout: ${failed}`)
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
            key="notify"
            label={`${notifies ? GLYPH.done : GLYPH.pending} notify`}
            dimColor={!notifies}
            onPress={() =>
              void setOption($, 'notify', !notifies).then(failed => {
                if (failed) $.ui.toast(`Could not set notify: ${failed}`)
              })
            }
          />
        </Box>
      )

    // The controls beside ⚙: share this board under its own name, join one another session
    // shared, or leave the one followed. The row's left side names the board, own or shared.
    const boards = following
      ? []
      : (await $.store.keys()).filter(key => key.startsWith(SHARED_PREFIX)).map(key => key.slice(SHARED_PREFIX.length))
    const canShare = todo.name !== undefined && lists.some(list => list.items.length > 0)
    const toastIfRefused = (outcome: Joined | string) => {
      if (typeof outcome === 'string') $.ui.toast(outcome)
    }
    const heading = following ? `⇄ ${following.name} · signs as ${following.label}` : todo.name ? `board ${todo.name}` : ''
    const controls = following ? (
      <Button plain key="leave" label="leave" onPress={() => void leaveBoard($)} />
    ) : (
      <Box flexDirection="row" gap={2}>
        {canShare && (
          <Button plain key="share" label={`⇄ share ${todo.name}`} onPress={() => void shareBoard($, undefined, undefined).then(toastIfRefused)} />
        )}
        {boards.length > 0 &&
          e.surface !== 'mobile' &&
          (() => {
            const { Select } = $.ui.resolve(e)
            return (
              <Select
                key="join"
                value=""
                options={[{ value: '', label: 'join…' }, ...boards.map(name => ({ value: name, label: name }))]}
                onSelect={value => {
                  if (value) void joinBoard($, value, undefined).then(toastIfRefused)
                }}
              />
            )
          })()}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} minHeight={e.props.scroll.bodyRows}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text dimColor wrap="truncate-end">
            {heading}
          </Text>
          <Box flexDirection="row" gap={2} flexShrink={0}>
            {controls}
            <Button
              plain
              key="settings"
              label="⚙"
              dimColor={!isSettingsOpen}
              onPress={() => void update($, settingsOpen, open => !open)}
            />
          </Box>
        </Box>
        {settings}
        <Box marginBottom={1}>
          <Text dimColor wrap="truncate-end">
            {'─'.repeat(Math.max(4, e.props.bodyColumns - 2))}
          </Text>
        </Box>
        {drawBoard($, { Box, Text, Button }, todo, { theme, isCompact, bodyColumns: e.props.bodyColumns, canCopy: isFocused })}
        <Box flexGrow={1} />
        {friday && (
          <Box flexDirection="column" marginTop={1}>
            {FRIDAY_BUBBLE.map((line, i) => (
              <Text key={`bubble:${i}`} wrap="truncate-end">
                {line}
              </Text>
            ))}
            {FRIDAY_GUY.map((line, i) => (
              <Text key={`guy:${i}`} color={theme.accent} wrap="truncate-end">
                {line}
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
