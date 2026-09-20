const { AsyncLocalStorage } = require('node:async_hooks')
const { parentPort, workerData } = require('node:worker_threads')
const { Script, createContext } = require('node:vm')

const BRIDGE_FACTORY = new Script(`"use strict";
((hostCall) => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const promiseResolve = Promise.resolve.bind(Promise);
  const promiseThen = Promise.prototype.then;
  return (...args) =>
    promiseThen.call(promiseResolve(hostCall(stringify(args))), (payloadJson) => {
      const payload = parse(payloadJson);
      if (!payload.ok) throw new Error(payload.error || 'Hive workflow host call failed');
      return payload.hasValue ? payload.value : undefined;
    });
})`)

const FLOW_FACTORY = new Script(`"use strict";
((agentBase, catchPerItem, cancelDagLayerAgents, planDag, dagLayerContext) => {
  const promiseAll = Promise.all.bind(Promise);
  const promiseResolve = Promise.resolve.bind(Promise);
  const promiseThen = Promise.prototype.then;
  const promiseCatch = Promise.prototype.catch;
  const ErrorCtor = Error;
  let dagLayerCounter = 0;
  const agent = (prompt, opts) => {
    const activeDagLayerId = dagLayerContext.getStore();
    if (!activeDagLayerId) return agentBase(prompt, opts);
    const nextOpts = opts && typeof opts === 'object' ? { ...opts } : {};
    nextOpts.__hiveDagLayerId = activeDagLayerId;
    return agentBase(prompt, nextOpts);
  };
  const normalizeDagNodes = (spec) => {
    const rawNodes = Array.isArray(spec)
      ? spec
      : spec && Array.isArray(spec.nodes)
        ? spec.nodes
        : null;
    if (!rawNodes) throw new Error('dag(): expected an array of nodes or { nodes }');
    return rawNodes.map((node, index) => {
      if (!node || typeof node !== 'object') {
        throw new Error('dag(): node #' + (index + 1) + ' must be an object');
      }
      const id = typeof node.id === 'string' ? node.id.trim() : '';
      if (!id) throw new Error('dag(): node #' + (index + 1) + ' requires a non-empty string id');
      const rawDeps = node.needs ?? node.dependsOn ?? node.after ?? [];
      const deps = Array.isArray(rawDeps) ? rawDeps.map((dep) => String(dep).trim()) : [String(rawDeps).trim()];
      for (const dep of deps) {
        if (!dep) throw new Error('dag(' + id + '): dependency ids must be non-empty strings');
      }
      if (typeof node.run !== 'function') {
        throw new Error('dag(' + id + '): node.run must be a function');
      }
      return { deps, id, run: node.run };
    });
  };
  const runDagNode = (node, results) => {
    if (typeof node.run !== 'function') {
      throw new Error('dag(' + node.id + '): node.run must be a function');
    }
    const deps = Object.create(null);
    for (const dep of node.deps) deps[dep] = results[dep];
    return node.run(deps, results);
  };
  const runDagNodeInLayer = (layerId, node, results) =>
    dagLayerContext.run(layerId, () => runDagNode(node, results));
  const reportItemFailure = (error) => {
    let value = error;
    try {
      if (error instanceof ErrorCtor) value = error.message;
    } catch {
      // Keep the original JSON behavior if diagnostic extraction fails.
      return catchPerItem(error);
    }
    return catchPerItem(value);
  };
  const parallel = (thunks) =>
    promiseAll(Array.from(thunks).map((thunk) =>
      promiseCatch.call(promiseThen.call(promiseResolve(), () => thunk()), reportItemFailure)
    ));
  const pipeline = (items, ...stages) =>
    promiseAll(Array.from(items).map((item, index) => {
      let chain = promiseResolve(item);
      for (const stage of stages) {
        chain = promiseThen.call(chain, (prev) => stage(prev, item, index));
      }
      return promiseCatch.call(chain, reportItemFailure);
    }));
  const dag = async (spec) => {
    const nodes = normalizeDagNodes(spec);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const plan = await planDag(nodes.map((node) => ({ id: node.id, deps: node.deps })));
    const order = [];
    const results = Object.create(null);
    for (const layer of plan.layers) {
      const layerId = 'dag-layer-' + (++dagLayerCounter);
      let values;
      let cancelError;
      try {
        values = await promiseAll(layer.map((id) =>
          promiseThen.call(promiseResolve(), () =>
            runDagNodeInLayer(layerId, byId.get(id), results)
          )
        ));
      } catch (error) {
        const message = error && typeof error.message === 'string' ? error.message : String(error);
        try {
          await cancelDagLayerAgents(layerId, 'DAG node failed: ' + message);
        } catch (cancelFailure) {
          cancelError = cancelFailure;
        }
        if (cancelError) {
          const cancelMessage =
            cancelError && typeof cancelError.message === 'string'
              ? cancelError.message
              : String(cancelError);
          throw new Error(message + '; failed to cancel DAG sibling agents: ' + cancelMessage);
        }
        throw error;
      }
      for (let index = 0; index < layer.length; index += 1) {
        const node = byId.get(layer[index]);
        const value = values[index];
        results[node.id] = value === undefined ? null : value;
        order.push(node.id);
      }
    }
    return { order, results };
  };
  return { agent, dag, parallel, pipeline };
})`)

const JSON_PARSE = new Script('JSON.parse')
const DAG_LAYER_CONTEXT = new AsyncLocalStorage()

const encodeSuccess = (value) => {
  const payload = { ok: true, hasValue: value !== undefined }
  if (value !== undefined) payload.value = value
  return JSON.stringify(payload)
}

const encodeFailure = (error) =>
  JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })

const createSafeHostCall = (fn) =>
  new Proxy(
    (serializedArgs) => {
      let args
      try {
        const parsed = JSON.parse(serializedArgs)
        args = Array.isArray(parsed) ? parsed : []
      } catch (error) {
        return encodeFailure(error)
      }
      try {
        return Promise.resolve(fn(args)).then(encodeSuccess, encodeFailure)
      } catch (error) {
        return encodeFailure(error)
      }
    },
    {
      get: () => undefined,
      getOwnPropertyDescriptor: () => undefined,
      getPrototypeOf: () => null,
      has: () => false,
      ownKeys: () => [],
      set: () => false,
    }
  )

let nextCallId = 0
const pending = new Map()

parentPort.on('message', (message) => {
  if (!message || message.type !== 'hostResponse') return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.ok) entry.resolve(message.value)
  else entry.reject(new Error(message.error || 'Hive workflow host call failed'))
})

const callHost = (name, args) =>
  new Promise((resolve, reject) => {
    const id = String(++nextCallId)
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ type: 'hostCall', id, name, args })
  })

const cloneIntoVm = (context, value) => {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return undefined
  return JSON_PARSE.runInContext(context)(serialized)
}

const cloneOutOfVm = (value) => {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  return serialized === undefined ? undefined : JSON.parse(serialized)
}

;(async () => {
  try {
    const context = createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    })
    const bridgeFactory = BRIDGE_FACTORY.runInContext(context, { timeout: 1000 })
    const bridge = (name) => bridgeFactory(createSafeHostCall((args) => callHost(name, args)))
    const vmAgentBase = bridge('agent')
    const vmPhase = bridge('phase')
    const vmLog = bridge('log')
    const vmWorkflow = bridge('workflow')
    const vmCatchPerItem = bridge('catchPerItem')
    const vmCancelDagLayerAgents = bridge('cancelDagLayerAgents')
    const vmPlanDag = bridge('planDag')
    const {
      agent: vmAgent,
      dag,
      parallel,
      pipeline,
    } = FLOW_FACTORY.runInContext(context, {
      timeout: 1000,
    })(vmAgentBase, vmCatchPerItem, vmCancelDagLayerAgents, vmPlanDag, DAG_LAYER_CONTEXT)
    const fn = new Script(`"use strict";\n${workerData.compiledFunctionSource}\n; __wf`, {
      filename: workerData.scriptPath,
    }).runInContext(context, { timeout: 1000 })
    const value = cloneOutOfVm(
      await fn({
        agent: vmAgent,
        parallel,
        pipeline,
        phase: vmPhase,
        log: vmLog,
        workflow: vmWorkflow,
        dag,
        args: cloneIntoVm(context, workerData.args),
      })
    )
    parentPort.postMessage({ type: 'done', ok: true, value })
  } catch (error) {
    parentPort.postMessage({
      type: 'done',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})()
