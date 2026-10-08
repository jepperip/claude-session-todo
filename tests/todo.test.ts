import { expect, test } from 'claude-code/testing'

import type { TodoList } from '../types'

const TOOL = 'mcp__session-todo__todo'
const LIST = { plugin: 'session-todo', key: 'list' } as const

async function list($: Parameters<Parameters<typeof test>[1]>[0]): Promise<TodoList> {
  const { value } = await $.state.get(LIST)
  return value ?? { title: 'Todo', items: [] }
}

test('write replaces the list and gives every item an id', async $ => {
  await $.tool.call({
    tool: TOOL,
    action: 'write',
    title: 'Ship it',
    items: [{ text: 'Build' }, { text: 'Test', status: 'in_progress' }, { id: 'keep', text: 'Deploy' }],
  })
  const todo = await list($)
  expect(todo.title).toBe('Ship it')
  expect(todo.items.map(item => item.text)).toEqual(['Build', 'Test', 'Deploy'])
  expect(todo.items.map(item => item.status)).toEqual(['pending', 'in_progress', 'pending'])
  expect(todo.items[2]?.id).toBe('keep')
  expect(new Set(todo.items.map(item => item.id)).size).toBe(3)
})

test('update moves one item and leaves the rest', async $ => {
  await $.tool.call({ tool: TOOL, action: 'write', items: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }] })
  await $.tool.call({ tool: TOOL, action: 'update', id: 'a', status: 'done' })
  const todo = await list($)
  expect(todo.items.find(item => item.id === 'a')?.status).toBe('done')
  expect(todo.items.find(item => item.id === 'b')?.status).toBe('pending')
})

test('update of an unknown id is refused and changes nothing', async $ => {
  await $.tool.call({ tool: TOOL, action: 'write', items: [{ id: 'a', text: 'One' }] })
  const answer = await $.tool.call({ tool: TOOL, action: 'update', id: 'nope', status: 'done' })
  expect(answer.isError).toBe(true)
  const todo = await list($)
  expect(todo.items).toHaveLength(1)
  expect(todo.items[0]?.status).toBe('pending')
})

test('/todo add and done edit by number', async $ => {
  await $.command.run({ command: 'todo', args: 'add Write the docs' })
  await $.command.run({ command: 'todo', args: 'add Review' })
  await $.command.run({ command: 'todo', args: 'done 1' })
  const todo = await list($)
  expect(todo.items.map(item => item.text)).toEqual(['Write the docs', 'Review'])
  expect(todo.items.map(item => item.status)).toEqual(['done', 'pending'])
})
