import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__session-todo__todo'

type Body = Parameters<typeof test>[1]
type Engine = Parameters<Body>[0]
type On = Parameters<Body>[1]

/** What the kit leaves unanswered beneath the plugin: the clock, the store, the session id, the status line and the pane. */
function engine(on: On): { stored: Map<string, unknown>; clock: ReturnType<typeof mock.clock>; toasts: string[] } {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // The poll of a shared board never fires here: the mock clock stands still, and a test writes
  // the store itself in another session's stead.
  return { stored, clock, toasts }
}

/** The lists as the tool renders them for the model: the pane's text, one line per list and item. */
async function shown($: Engine): Promise<string> {
  const answer = await $.tool.call({ tool: TOOL, action: 'read' })
  if (typeof answer.result !== 'string') throw new Error(`read answered ${JSON.stringify(answer)}`)
  return answer.result
}

/** The item ids in the rendered text, in order. */
function idsIn(text: string): string[] {
  return [...text.matchAll(/ \(([^()\s]+)\)(?: — |$)/gm)].map(match => match[1] as string)
}

test('write creates a named list, makes it active and gives every item an id', async ($, on) => {
  engine(on)
  await $.tool.call({
    tool: TOOL,
    action: 'write',
    list: 'feature',
    title: 'Ship it',
    items: [{ text: 'Build' }, { text: 'Test', status: 'in_progress' }, { id: 'keep', text: 'Deploy' }],
  })
  const text = await shown($)
  expect(text).toContain('Ship it [feature] (active) 0/3 done')
  expect(text).toContain('[ ] 1. Build (')
  expect(text).toContain('[>] 2. Test (')
  expect(text).toContain('[ ] 3. Deploy (keep)')
  const ids = idsIn(text)
  expect(ids).toHaveLength(3)
  expect(new Set(ids).size).toBe(3)
})

test('a second list keeps ids unique across lists and does not steal focus', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'feature', items: [{ text: 'Build' }] })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'followup', items: [{ text: 'Open the PR' }] })
  await $.tool.call({ tool: TOOL, action: 'add', list: 'followup', text: 'Report to Jira' })
  const text = await shown($)
  expect(text).toContain('[feature] (active)')
  expect(text).toContain('[followup] 0/2 done')
  expect(text).not.toContain('[followup] (active)')
  const ids = idsIn(text)
  expect(ids).toHaveLength(3)
  expect(new Set(ids).size).toBe(3)
  await $.tool.call({ tool: TOOL, action: 'focus', list: 'followup' })
  expect(await shown($)).toContain('[followup] (active)')
})

test('about is kept to one short line: set on write, kept across writes, changed by describe', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', about: '  Why this   list exists ', items: [{ text: 'One' }] })
  expect(await shown($)).toContain('\n  Why this list exists\n')
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', items: [{ text: 'Two' }] })
  expect(await shown($)).toContain('\n  Why this list exists\n')
  await $.tool.call({ tool: TOOL, action: 'describe', list: 'a', about: '' })
  expect(await shown($)).not.toContain('Why this list exists')
})

test('a long about never fails the call: it is cut at a word with an ellipsis and the result says so', async ($, on) => {
  engine(on)
  const long = 'Done when the gateway, the resource group and the storage vnet are all gone from the subscription'
  const answer = await $.tool.call({ tool: TOOL, action: 'write', list: 'a', about: long, items: [{ text: 'One' }] })
  expect(answer.deny).toBeUndefined()
  expect(answer.result).toContain(`about was ${long.length} characters and is cut to 80`)
  const text = await shown($)
  const line = text.split('\n').find(one => one.startsWith('  Done when'))
  expect(line).toBeDefined()
  expect(line?.trim().length).toBeLessThanOrEqual(80)
  expect(line?.endsWith('…')).toBe(true)
  expect(line).not.toContain('subscri')
})

test('update finds an item in any list by id and leaves the rest', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', items: [{ id: 'one', text: 'One' }] })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'b', items: [{ id: 'two', text: 'Two' }] })
  await $.tool.call({ tool: TOOL, action: 'update', id: 'two', status: 'done' })
  const text = await shown($)
  expect(text).toContain('[ ] 1. One (one)')
  expect(text).toContain('[x] 2. Two (two)')
})

test('update of an unknown id is refused and changes nothing', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', items: [{ id: 'a', text: 'One' }] })
  const answer = await $.tool.call({ tool: TOOL, action: 'update', id: 'nope', status: 'done' })
  expect(answer.deny).toContain('no item with id nope')
  expect(await shown($)).toContain('[ ] 1. One (a)')
})

test('drop removes a list and moves focus to the first remaining one', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', items: [{ text: 'One' }] })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'b', items: [{ text: 'Two' }] })
  await $.tool.call({ tool: TOOL, action: 'focus', list: 'b' })
  await $.tool.call({ tool: TOOL, action: 'drop', list: 'b' })
  const text = await shown($)
  expect(text).toContain('[a] (active)')
  expect(text).not.toContain('[b]')
})

test('/todo add targets a list with @name and done counts items in pane order', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'todo', args: 'add Write the docs' })
  await $.command.run({ command: 'todo', args: 'add @followup Open the PR' })
  const { text } = await $.command.run({ command: 'todo', args: 'done 2' })
  expect(text).toContain('[main] (active)')
  expect(text).toContain('[ ] 1. Write the docs (')
  expect(text).toContain('[followup] 1/1 done')
  expect(text).toContain('[x] 2. Open the PR (')
})

test('share publishes the own board, changes go to the shared one signed, and leave restores the own board', async ($, on) => {
  const { stored } = engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'plan', items: [{ id: 'one', text: 'One' }] })
  const { text: sharedText } = await $.command.run({ command: 'todo', args: 'share plan as planner' })
  expect(sharedText).toContain('Shared board "plan" (this session signs as "planner")')
  expect(stored.has('shared:plan')).toBe(true)

  await $.command.run({ command: 'todo', args: 'add Two' })
  const published = stored.get('shared:plan') as { lists: Array<{ items: Array<{ text: string; by?: string }> }> }
  const two = published.lists[0]?.items.find(item => item.text === 'Two')
  expect(two?.by).toBe('planner')
  const own = stored.get('board:test-session') as { lists: Array<{ items: unknown[] }> }
  expect(own.lists[0]?.items).toHaveLength(1)

  const { text: left } = await $.command.run({ command: 'todo', args: 'leave' })
  expect(left).toContain('Left the shared board plan')
  const text = await shown($)
  expect(text).toContain('One (one)')
  expect(text).not.toContain('Two')
  expect(text).not.toContain('Shared board')
})

test('a change on a shared board is applied over what other sessions wrote since the last poll', async ($, on) => {
  const { stored } = engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'plan', items: [{ id: 'one', text: 'One' }] })
  await $.command.run({ command: 'todo', args: 'share plan as planner' })

  // Another session adds an item straight into the store, as its own commit would.
  const published = stored.get('shared:plan') as { lists: Array<{ items: object[] }>; nextId: number }
  const first = published.lists[0]
  if (!first) throw new Error('no list published')
  stored.set('shared:plan', {
    ...published,
    lists: [{ ...first, items: [...first.items, { id: 'x9', text: 'Theirs', status: 'in_progress', owner: 'agent', by: 'worker' }] }],
    nextId: 99,
  })

  const answer = await $.tool.call({ tool: TOOL, action: 'add', text: 'Mine' })
  expect(answer.result).toContain('[>] 2. Theirs (x9) @worker')
  expect(answer.result).toContain('3. Mine (t99) @planner')
  expect(answer.result).toContain('[ ] 1. One (one)\n')
})

test('a board named by the agent shares under that name without an argument', async ($, on) => {
  const { stored } = engine(on)
  const refused = await $.command.run({ command: 'todo', args: 'share' })
  expect(refused.text).toContain('the board has no name yet')

  const answer = await $.tool.call({ tool: TOOL, action: 'write', board: 'DAN-1234', list: 'plan', items: [{ text: 'One' }] })
  expect(answer.result).toContain('Board "DAN-1234" (shareable under that name)')
  const { text } = await $.command.run({ command: 'todo', args: 'share' })
  expect(text).toContain('Shared board "DAN-1234"')
  expect(stored.has('shared:DAN-1234')).toBe(true)

  const renamed = await $.command.run({ command: 'todo', args: 'name other' })
  expect(renamed.text).toContain('follows the shared board DAN-1234, which keeps its name')
})

test('a session start drops boards untouched for 30 days and keeps the rest', async ($, on) => {
  const { stored, clock } = engine(on)
  const day = 24 * 60 * 60 * 1000
  await clock.set(100 * day)
  const now = clock.now()
  const board = (updatedAt?: number) => ({ lists: [{ name: 'main', title: 'main', items: [] }], nextId: 1, ...(updatedAt === undefined ? {} : { updatedAt }) })
  stored.set('board:old-session', board(now - 31 * day))
  stored.set('follow:old-session', { name: 'stale', label: 'x' })
  stored.set('shared:stale', board(now - 31 * day))
  stored.set('shared:fresh', board(now - 2 * day))
  stored.set('shared:unstamped', board())

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
  expect(stored.has('board:old-session')).toBe(false)
  expect(stored.has('follow:old-session')).toBe(false)
  expect(stored.has('shared:stale')).toBe(false)
  expect(stored.has('shared:fresh')).toBe(true)
  expect((stored.get('shared:unstamped') as { updatedAt?: number }).updatedAt).toBe(now)

  const { text } = await $.command.run({ command: 'todo', args: 'boards' })
  expect(text).toContain('fresh: 0/0 done, last change 2 days ago')
  expect(text).toContain('unstamped: 0/0 done, last change today')
})

test('join follows an existing shared board and refuses a missing one', async ($, on) => {
  const { stored } = engine(on)
  stored.set('shared:plan', { lists: [{ name: 'plan', title: 'The plan', items: [{ id: 'p1', text: 'Step', status: 'pending' }] }], nextId: 2 })
  const refused = await $.tool.call({ tool: TOOL, action: 'join', board: 'nope' })
  expect(refused.deny).toContain('no shared board named nope')

  const joined = await $.tool.call({ tool: TOOL, action: 'join', board: 'plan' })
  expect(joined.result).toContain('Shared board "plan" (this session signs as "test-s")')
  expect(joined.result).toContain('The plan [plan]')
  await $.tool.call({ tool: TOOL, action: 'update', id: 'p1', status: 'done' })
  const published = stored.get('shared:plan') as { lists: Array<{ items: Array<{ id: string; status: string; by?: string }> }> }
  expect(published.lists[0]?.items[0]).toMatchObject({ id: 'p1', status: 'done', by: 'test-s' })
})

test('an item that starts waiting on the person is toasted once; their own changes never toast', async ($, on) => {
  const { toasts } = engine(on)
  await $.tool.call({
    tool: TOOL,
    action: 'write',
    list: 'main',
    title: 'Plan',
    items: [
      { id: 'a', text: 'Build', status: 'in_progress' },
      { id: 'b', text: 'Ship' },
      { id: 'c', text: 'Approve the plan', owner: 'user' },
    ],
  })
  expect(toasts).toEqual([])

  // Blocked by the agent: one toast, and none again while it stays blocked.
  await $.tool.call({ tool: TOOL, action: 'update', id: 'a', status: 'blocked', note: 'needs the password' })
  expect(toasts).toEqual(['♟ needs you: Build'])
  await $.tool.call({ tool: TOOL, action: 'update', id: 'a', note: 'still needs it' })
  expect(toasts).toHaveLength(1)

  // The person finishes it themselves, and starts their own item themselves: no toast for either.
  await $.command.run({ command: 'todo', args: 'done 1' })
  await $.command.run({ command: 'todo', args: 'start 3' })
  expect(toasts).toHaveLength(1)
  await $.command.run({ command: 'todo', args: 'done 3' })

  // The agent starts a step of the person's: that is a poke.
  await $.tool.call({ tool: TOOL, action: 'add', text: 'Approve the release', owner: 'user', status: 'in_progress' })
  expect(toasts).toEqual(['♟ needs you: Build', '♟ needs you: Approve the release'])
})

test('the agent finishing a step that puts one of the person\'s up next pokes them', async ($, on) => {
  const { toasts } = engine(on)
  await $.tool.call({
    tool: TOOL,
    action: 'write',
    list: 'main',
    title: 'Plan',
    items: [
      { id: 'a', text: 'Build', status: 'in_progress' },
      { id: 'b', text: 'Click deploy', owner: 'user' },
    ],
  })
  await $.tool.call({ tool: TOOL, action: 'update', id: 'a', status: 'done' })
  expect(toasts).toEqual(['♟ needs you: Click deploy'])
})

test('a change the person makes is told to the model as a note; the agent\'s own changes are not', async ($, on) => {
  engine(on)
  const session = mock.session(on)
  const noteTexts = () =>
    session.appended().map(row => {
      const content = row.message.content
      const first = Array.isArray(content) ? content[0] : undefined
      return first && typeof first === 'object' && 'text' in first ? String(first.text) : String(content)
    })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'main', title: 'Plan', items: [{ id: 'a', text: 'Build' }, { id: 'b', text: 'Ship' }] })
  await $.tool.call({ tool: TOOL, action: 'update', id: 'a', status: 'done' })
  expect(noteTexts().filter(text => text.startsWith('session-todo:'))).toEqual([])

  await $.command.run({ command: 'todo', args: 'done 2' })
  await $.command.run({ command: 'todo', args: 'add Review it' })
  const notes = noteTexts().filter(text => text.startsWith('session-todo:'))
  expect(notes).toEqual(['session-todo: the person marked "Ship" (b) done.', 'session-todo: the person added "Review it" to the main list as their own item.'])
})

test('notify off keeps the toast away', { options: { notify: false } }, async ($, on) => {
  const { toasts } = engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'main', title: 'Plan', items: [{ id: 'a', text: 'Build', status: 'in_progress' }] })
  await $.tool.call({ tool: TOOL, action: 'update', id: 'a', status: 'blocked' })
  expect(toasts).toEqual([])
})
