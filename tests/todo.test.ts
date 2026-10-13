import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__session-todo__todo'

type Body = Parameters<typeof test>[1]
type Engine = Parameters<Body>[0]
type On = Parameters<Body>[1]

/** What the kit leaves unanswered beneath the plugin: the store, the session id, the status line and the pane. */
function engine(on: On): Map<string, unknown> {
  const stored = new Map<string, unknown>()
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
  // The poll of a shared board never fires here: a test writes the store itself in another session's stead.
  on('clock.every', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  return stored
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
  const stored = engine(on)
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
  const stored = engine(on)
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
  const stored = engine(on)
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

test('join follows an existing shared board and refuses a missing one', async ($, on) => {
  const stored = engine(on)
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
