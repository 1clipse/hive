export interface WorkflowDagNodeInput {
  deps: string[]
  id: string
}

export interface WorkflowDagPlan {
  layers: string[][]
}

const assertDagNodeInput = (node: unknown, index: number): WorkflowDagNodeInput => {
  if (!node || typeof node !== 'object') {
    throw new Error(`dag(): node #${index + 1} must be an object`)
  }
  const record = node as { deps?: unknown; id?: unknown }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) throw new Error(`dag(): node #${index + 1} requires a non-empty string id`)
  if (!Array.isArray(record.deps)) {
    throw new Error(`dag(${id}): deps must be an array`)
  }
  const deps = record.deps.map((dep) => String(dep).trim())
  for (const dep of deps) {
    if (!dep) throw new Error(`dag(${id}): dependency ids must be non-empty strings`)
  }
  return { deps, id }
}

export const planWorkflowDag = (input: unknown): WorkflowDagPlan => {
  if (!Array.isArray(input)) {
    throw new Error('dag(): expected planner input to be an array of nodes')
  }

  const nodes = input.map(assertDagNodeInput)
  const remainingDeps = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const node of nodes) {
    if (remainingDeps.has(node.id)) throw new Error(`dag(): duplicate node id "${node.id}"`)
    remainingDeps.set(node.id, node.deps.length)
    dependents.set(node.id, [])
  }

  for (const node of nodes) {
    for (const dep of node.deps) {
      const children = dependents.get(dep)
      if (!children) throw new Error(`dag(${node.id}): unknown dependency "${dep}"`)
      children.push(node.id)
    }
  }

  const queue = nodes.filter((node) => node.deps.length === 0).map((node) => node.id)
  const layers: string[][] = []
  let cursor = 0
  let visited = 0

  while (cursor < queue.length) {
    const layer = queue.slice(cursor)
    cursor = queue.length
    layers.push(layer)
    for (const id of layer) {
      visited += 1
      for (const childId of dependents.get(id) ?? []) {
        const next = (remainingDeps.get(childId) ?? 0) - 1
        remainingDeps.set(childId, next)
        if (next === 0) queue.push(childId)
      }
    }
  }

  if (visited !== nodes.length) {
    const cyclic = nodes
      .filter((node) => (remainingDeps.get(node.id) ?? 0) > 0)
      .map((node) => node.id)
    throw new Error(`dag(): cycle or unsatisfied dependencies among: ${cyclic.join(', ')}`)
  }

  return { layers }
}
