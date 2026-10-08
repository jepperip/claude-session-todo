import { expect, test } from 'claude-code/testing'

import type { TodoBoard } from '../types'

const TOOL = 'mcp__session-todo__todo'
const BOARD = { plugin: 'session-todo', key: 'board' } as const

async function board($: Parameters<Parameters<typeof test>[1]>[0]): Promise<TodoBoard> {
  const { value } = await $.state.get(BOARD)
  return value ?? { lists: [], nextId: 1 }
}

test('write creates a named list, makes it active and gives every item an id', async $ => {
  await $.tool.call({
    tool: TOOL,
    action: 'write',
    list: 'feature',
    title: 'Ship it',
    items: [{ text: 'Build' }, { text: 'Test', status: 'in_progress' }, { id: 'keep', text: 'Deploy' }],
  })
  const todo = await board($)
  expect(todo.active).toBe('feature')
  expect(todo.lists).toHaveLength(1)
  const list = todo.lists[0]
  expect(list?.title).toBe('Ship it')
  expect(list?.items.map(item => item.text)).toEqual(['Build', 'Test', 'Deploy'])
  expect(list?.items.map(item => item.status)).toEqual(['pending', 'in_progress', 'pending'])
  expect(list?.items[2]?.id).toBe('keep')
  expect(new Set(list?.items.map(item => item.id)).size).toBe(3)
})

test('a second list keeps ids unique across lists and does not steal focus', async $ => {
  await $.tool.call({ tool: TOOL, action: 'write', list: 'feature', items: [{ text: 'Build' }] })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'followup', items: [{ text: 'Open the PR' }] })
  await $.tool.call({ tool: TOOL, action: 'add', list: 'followup', text: 'Report to Jira' })
  const todo = await board($)
  expect(todo.lists.map(list => list.name)).toEqual(['feature', 'followup'])
  expect(todo.active).toBe('feature')
  await $.tool.call({ tool: TOOL, action: 'focus', list: 'followup' })
  expect((await board($)).active).toBe('followup')
  const ids = todo.lists.flatMap(list => list.items.map(item => item.id))
  expect(new Set(ids).size).toBe(ids.length)
})

test('update finds an item in any list by id and leaves the rest', async $ => {
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', items: [{ id: 'one', text: 'One' }] })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'b', items: [{ id: 'two', text: 'Two' }] })
  await $.tool.call({ tool: TOOL, action: 'update', id: 'one', status: 'done' })
  const todo = await board($)
  expect(todo.lists[0]?.items[0]?.status).toBe('done')
  expect(todo.lists[1]?.items[0]?.status).toBe('pending')
})

test('update of an unknown id is refused and changes nothing', async $ => {
  await $.tool.call({ tool: TOOL, action: 'write', items: [{ id: 'a', text: 'One' }] })
  const answer = await $.tool.call({ tool: TOOL, action: 'update', id: 'nope', status: 'done' })
  expect(answer.isError).toBe(true)
  const todo = await board($)
  expect(todo.lists[0]?.items).toHaveLength(1)
  expect(todo.lists[0]?.items[0]?.status).toBe('pending')
})

test('drop removes a list and moves focus to the first remaining one', async $ => {
  await $.tool.call({ tool: TOOL, action: 'write', list: 'a', items: [{ text: 'One' }] })
  await $.tool.call({ tool: TOOL, action: 'write', list: 'b', items: [{ text: 'Two' }] })
  await $.tool.call({ tool: TOOL, action: 'drop', list: 'b' })
  const todo = await board($)
  expect(todo.lists.map(list => list.name)).toEqual(['a'])
  expect(todo.active).toBe('a')
})

test('/todo add targets a list with @name and done counts items in pane order', async $ => {
  await $.command.run({ command: 'todo', args: 'add Write the docs' })
  await $.command.run({ command: 'todo', args: 'add @followup Open the PR' })
  await $.command.run({ command: 'todo', args: 'done 2' })
  const todo = await board($)
  expect(todo.lists.map(list => list.name)).toEqual(['main', 'followup'])
  expect(todo.lists[0]?.items[0]?.status).toBe('pending')
  expect(todo.lists[1]?.items[0]?.status).toBe('done')
})
