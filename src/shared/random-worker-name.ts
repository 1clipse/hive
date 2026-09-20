import agentNamesBank from './agent-names.json' with { type: 'json' }

/* Worker names are drawn from the vendored agent-name-bank snapshot
   (`agent-names.json`). Every role and UI language shares one pool — the
   `name` field of each entry — so Add Member and scenario presets stay in
   sync. Names are returned exactly as stored (spaces, dots, mid-dots,
   hyphens, and casing preserved). Callers that need `team send` safety
   must quote multi-word names: `team send "<member-name>" "<task>"`. */

export const WORKER_NAME_POOL: readonly string[] = agentNamesBank.names.map((entry) => entry.name)

const nextRandomUint32 = (): number => {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] ?? 0
}

export interface GenerateWorkerNameOptions {
  /* Names already taken in the current workspace. Excluded from the draw
     so the new worker doesn't collide with an existing one. Different
     workspaces are kept independent — the caller passes only its own
     workspace's names. */
  usedNames?: ReadonlySet<string>
  nextUint32?: () => number
}

export const generateWorkerName = ({
  usedNames,
  nextUint32 = nextRandomUint32,
}: GenerateWorkerNameOptions = {}): string => {
  const pool = WORKER_NAME_POOL
  const available =
    usedNames && usedNames.size > 0 ? pool.filter((name) => !usedNames.has(name)) : pool
  // Exhaustion is a corner case we tolerate by falling back to the full pool
  // and accepting a duplicate rather than throwing or returning an empty string.
  const draw = available.length > 0 ? available : pool
  return draw[nextUint32() % draw.length] as string
}
