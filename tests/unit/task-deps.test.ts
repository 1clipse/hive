import { describe, expect, test } from 'vitest'

import { computeRunnableTasks, parseTasksWithDeps } from '../../src/server/task-deps.js'

describe('parseTasksWithDeps', () => {
  test('numbers task lines 1-based and reads their done state', () => {
    const md = ['# Plan', '- [ ] first', '- [x] second', 'not a task', '- [ ] third'].join('\n')
    const tasks = parseTasksWithDeps(md)
    expect(tasks.map((t) => [t.index, t.done, t.text])).toEqual([
      [1, false, 'first'],
      [2, true, 'second'],
      [3, false, 'third'],
    ])
  })

  test('parses and strips a trailing [needs: #n, #n] annotation', () => {
    const tasks = parseTasksWithDeps('- [ ] wire it up [needs: #1, #2]')
    expect(tasks[0]?.needs).toEqual([1, 2])
    // The annotation is removed from the human-readable text.
    expect(tasks[0]?.text).toBe('wire it up')
  })

  test('a line with no annotation has empty needs', () => {
    expect(parseTasksWithDeps('- [ ] plain task')[0]?.needs).toEqual([])
  })

  test('ignores GFM task lines inside fenced code blocks', () => {
    const md = [
      '- [x] real done',
      '',
      '```',
      '- [ ] example in a fence (NOT a real task)',
      '```',
      '',
      '- [ ] blocked on the fenced line [needs: #2]',
      '- [ ] actually runnable',
    ].join('\n')
    const tasks = parseTasksWithDeps(md)
    expect(tasks.map((t) => [t.index, t.text])).toEqual([
      [1, 'real done'],
      [2, 'blocked on the fenced line'],
      [3, 'actually runnable'],
    ])
    expect(computeRunnableTasks(md).map((t) => t.text)).toEqual(['actually runnable'])
  })
})

describe('computeRunnableTasks', () => {
  test('offers a task whose only dependency is done, withholds one whose dep is open', () => {
    const md = [
      '- [x] design', // #1 done
      '- [ ] build [needs: #1]', // #2 runnable (dep done)
      '- [ ] ship [needs: #2]', // #3 blocked (dep #2 not done)
    ].join('\n')
    const runnable = computeRunnableTasks(md)
    expect(runnable.map((t) => t.index)).toEqual([2])
    expect(runnable[0]?.text).toBe('build')
  })

  test('a task with no dependencies is runnable while undone', () => {
    expect(computeRunnableTasks('- [ ] just do it').map((t) => t.index)).toEqual([1])
  })

  test('done tasks never appear in the runnable set', () => {
    expect(computeRunnableTasks('- [x] already done')).toEqual([])
  })

  test('a dependency on a non-existent task withholds the task', () => {
    // Would-be-runnable if unknown deps defaulted to satisfied — they must not.
    expect(computeRunnableTasks('- [ ] orphan [needs: #99]')).toEqual([])
  })

  test('all dependencies must be done, not just one', () => {
    const md = ['- [x] a', '- [ ] b', '- [ ] c [needs: #1, #2]'].join('\n')
    expect(computeRunnableTasks(md).map((t) => t.index)).toEqual([2]) // only b; c waits on #2
  })
})
