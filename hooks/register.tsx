import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodoItem, TodoList, TodoStatus } from '../types'

const PLUGIN = 'session-todo'
const PANE = 'session-todo'
const TOOL = 'mcp__session-todo__todo'
const COMMAND = 'todo'
const EMPTY: TodoList = { title: 'Todo', items: [] }

const list = atom({ plugin: 'session-todo', key: 'list' } as const, EMPTY)

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'blocked']

const GLYPH: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  done: '[x]',
  blocked: '[!]',
}

const LEGEND = `${GLYPH.pending} pending  ${GLYPH.in_progress} in progress  ${GLYPH.done} done  ${GLYPH.blocked} blocked  · click a glyph to cycle`

type TodoToolInput = {
  action: 'write' | 'add' | 'update' | 'remove' | 'read' | 'clear'
  title?: string
  items?: Array<{ id?: string; text: string; status?: TodoStatus; note?: string }>
  id?: string
  text?: string
  status?: TodoStatus
  note?: string
}

const TOOL_DESCRIPTION = [
  'The session todo list the user watches in the Todo side pane. It is their view of the plan, so keep it current without being asked:',
  '- write: when work has more than one step, replace the list with the steps before starting (title optional).',
  '- update: mark the step you begin in_progress (one at a time) and done the moment it finishes; blocked with a note when it is waiting on the user.',
  '- add / remove: as steps appear or fall away.',
  '- read: the list as the pane shows it, with ids.',
  'Items are addressed by id. Keep item text short and imperative, one line each.',
].join('\n')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['write', 'add', 'update', 'remove', 'read', 'clear'] },
    title: { type: 'string', description: 'A heading for the list (write only).' },
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
    note: { type: 'string', description: 'A short note on the item, e.g. why it is blocked (add, update).' },
  },
  required: ['action'],
}

const PROMPT_SECTION = {
  id: 'session-todo:instructions',
  scope: 'session',
  text: [
    '# Session todo pane',
    `The user sees a live todo pane driven by the \`${TOOL}\` tool. Use it instead of narrating the plan: write the steps before multi-step work, keep exactly one item in_progress while you work on it, mark it done the moment it finishes, and add or remove items as the work changes. The pane is the user's way of seeing what is left without asking, so a stale list is worse than none.`,
  ].join('\n'),
} as const

function newId(items: readonly TodoItem[]): string {
  let n = items.length + 1
  const taken = new Set(items.map(item => item.id))
  while (taken.has(`t${n}`)) n++
  return `t${n}`
}

function nextStatus(status: TodoStatus): TodoStatus {
  if (status === 'pending') return 'in_progress'
  if (status === 'in_progress') return 'done'
  return 'pending'
}

function render(todo: TodoList): string {
  if (todo.items.length === 0) return `${todo.title}: empty`
  const rows = todo.items.map(
    (item, n) => `${GLYPH[item.status]} ${n + 1}. ${item.text} (${item.id})${item.note ? ` — ${item.note}` : ''}`,
  )
  const done = todo.items.filter(item => item.status === 'done').length
  return [`${todo.title} (${done}/${todo.items.length} done)`, ...rows].join('\n')
}

function statusLine(todo: TodoList): string | undefined {
  if (todo.items.length === 0) return undefined
  const done = todo.items.filter(item => item.status === 'done').length
  const current = todo.items.find(item => item.status === 'in_progress')
  const now = current ? ` · now: ${current.text}` : ''
  return `Todo ${done}/${todo.items.length}${now}`
}

function storeKey(sessionId: string): string {
  return `list:${sessionId}`
}

async function commit($: EngineInterface, change: (todo: TodoList) => TodoList): Promise<TodoList> {
  const todo = await update($, list, change)
  $.ui.status(statusLine(todo))
  await $.store.set(storeKey(await $.session.id()), todo)
  return todo
}

async function ensurePane($: EngineInterface): Promise<void> {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) await $.ui.open({ id: PANE, title: 'Todo' })
}

function applyTool(todo: TodoList, input: TodoToolInput): TodoList | string {
  switch (input.action) {
    case 'read':
      return todo
    case 'clear':
      return { ...todo, items: [] }
    case 'write': {
      const items: TodoItem[] = []
      for (const given of input.items ?? []) {
        if (!given.text) return 'every item needs a text'
        const item: TodoItem = {
          id: given.id && !items.some(one => one.id === given.id) ? given.id : newId(items),
          text: given.text,
          status: given.status ?? 'pending',
        }
        if (given.note) item.note = given.note
        items.push(item)
      }
      return { title: input.title ?? todo.title, items }
    }
    case 'add': {
      if (!input.text) return 'add needs a text'
      const item: TodoItem = { id: newId(todo.items), text: input.text, status: input.status ?? 'pending' }
      if (input.note) item.note = input.note
      return { ...todo, items: [...todo.items, item] }
    }
    case 'update': {
      const target = todo.items.find(item => item.id === input.id)
      if (!target) return `no item with id ${input.id ?? '(none)'}`
      return {
        ...todo,
        items: todo.items.map(item => {
          if (item.id !== target.id) return item
          const changed: TodoItem = { ...item }
          if (input.text) changed.text = input.text
          if (input.status) changed.status = input.status
          if (input.note !== undefined) {
            if (input.note) changed.note = input.note
            else delete changed.note
          }
          return changed
        }),
      }
    }
    case 'remove': {
      if (!todo.items.some(item => item.id === input.id)) return `no item with id ${input.id ?? '(none)'}`
      return { ...todo, items: todo.items.filter(item => item.id !== input.id) }
    }
    default:
      return `unknown action ${String((input as { action?: unknown }).action)}`
  }
}

function byNumber(todo: TodoList, arg: string): TodoItem | undefined {
  const n = Number.parseInt(arg, 10)
  if (Number.isFinite(n) && n >= 1 && n <= todo.items.length) return todo.items[n - 1]
  return todo.items.find(item => item.id === arg)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'todo',
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: 'The session todo pane: /todo, add <text>, start <n>, done <n>, remove <n>, clear',
      argumentHint: '[add <text> | start <n> | done <n> | remove <n> | clear]',
    })

    const saved = (await $.store.get(storeKey(await $.session.id()))) as TodoList | undefined
    if (saved && Array.isArray(saved.items)) {
      await update($, list, () => saved)
      $.ui.status(statusLine(saved))
    }

    void $.ui.open({ id: PANE, title: 'Todo' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, list, () => EMPTY)
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
    const before = await read($, list)
    const outcome = applyTool(before, input)
    if (typeof outcome === 'string') return { deny: `todo: ${outcome}` }
    const after = outcome === before ? before : await commit($, () => outcome)
    if (input.action !== 'read') await ensurePane($)
    return { result: render(after) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const todo = await read($, list)

    if (verb === '') {
      await ensurePane($)
      return { text: render(todo) }
    }
    if (verb === 'add') {
      if (!arg) return { text: 'Usage: /todo add <text>' }
      const after = await commit($, current => ({
        ...current,
        items: [...current.items, { id: newId(current.items), text: arg, status: 'pending' }],
      }))
      await ensurePane($)
      return { text: render(after) }
    }
    if (verb === 'clear') {
      const after = await commit($, current => ({ ...current, items: [] }))
      return { text: render(after) }
    }
    const target = byNumber(todo, arg)
    if (verb === 'start' || verb === 'done' || verb === 'remove') {
      if (!target) return { text: `No item ${arg || '(none)'}. Items are numbered as the pane shows them.` }
      const after = await commit($, current => ({
        ...current,
        items:
          verb === 'remove'
            ? current.items.filter(item => item.id !== target.id)
            : current.items.map(item =>
                item.id === target.id ? { ...item, status: verb === 'start' ? 'in_progress' : 'done' } : item,
              ),
      }))
      return { text: render(after) }
    }
    return { text: 'Usage: /todo [add <text> | start <n> | done <n> | remove <n> | clear]' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const todo = await read($, list)
    const done = todo.items.filter(item => item.status === 'done').length
    const current = todo.items.find(item => item.status === 'in_progress')

    const toggle = (item: TodoItem) => () =>
      void commit($, todo => ({
        ...todo,
        items: todo.items.map(one => (one.id === item.id ? { ...one, status: nextStatus(one.status) } : one)),
      }))

    return (
      <Box flexDirection="column" paddingX={1} gap={0}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{todo.title}</Text>
          <Text dimColor>{todo.items.length === 0 ? '' : `${done}/${todo.items.length} done`}</Text>
        </Box>
        {todo.items.length === 0 && (
          <Text dimColor>Nothing planned yet. The agent fills this in as work is planned; /todo add adds your own.</Text>
        )}
        {todo.items.map((item, n) => (
          <Box key={`row:${item.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button plain key={`toggle:${item.id}`} label={GLYPH[item.status]} dimColor={item.status === 'done'} onPress={toggle(item)} />
              <Text
                wrap="wrap"
                bold={item.status === 'in_progress'}
                dimColor={item.status === 'done'}
                strikethrough={item.status === 'done'}
                color={item.status === 'blocked' ? 'red' : item.status === 'in_progress' ? 'yellow' : undefined}
              >
                {`${n + 1}. ${item.text}`}
              </Text>
            </Box>
            {item.note && (
              <Box paddingLeft={4}>
                <Text dimColor wrap="wrap">{item.note}</Text>
              </Box>
            )}
          </Box>
        ))}
        {current && (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">{`now: ${current.text}`}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">{LEGEND}</Text>
        </Box>
      </Box>
    )
  })
}
