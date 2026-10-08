import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__session-todo__todo'

type Body = Parameters<typeof test>[1]
type Engine = Parameters<Body>[0]
type On = Parameters<Body>[1]

/** What the kit leaves unanswered beneath the plugin: the store, the session id, the status line and the pane. */
function engine(on: On): void {
  const stored = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
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

test('about is kept to one short line: set on write, changed by describe, refused past the cap', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', about: '  Why this   list exists ', items: [{ text: 'One' }] })
  expect(await shown($)).toContain('\n  Why this list exists\n')
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', items: [{ text: 'Two' }] })
  expect(await shown($)).toContain('\n  Why this list exists\n')
  const tooLong = await $.tool.call({ tool: TOOL, action: 'describe', list: 'a', about: 'x'.repeat(81) })
  expect(tooLong.deny).toContain('81 characters')
  expect(await shown($)).toContain('\n  Why this list exists\n')
  await $.tool.call({ tool: TOOL, action: 'describe', list: 'a', about: '' })
  expect(await shown($)).not.toContain('Why this list exists')
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
