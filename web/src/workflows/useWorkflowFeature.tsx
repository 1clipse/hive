import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import { getWorkflowFeature, setWorkflowFeature } from '../api.js'

interface WorkflowFeatureValue {
  /** Whether the experimental workflow feature is on. Off by default. */
  enabled: boolean
  /** True until the initial GET settles. */
  loading: boolean
  /** Persist the flag and update shared state so the topbar button + the
   *  settings toggle stay in sync. */
  setEnabled: (enabled: boolean) => Promise<void>
}

const WorkflowFeatureContext = createContext<WorkflowFeatureValue>({
  enabled: false,
  loading: true,
  setEnabled: async () => {},
})

export const WorkflowFeatureProvider = ({ children }: { children: ReactNode }) => {
  const [enabled, setEnabledState] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void getWorkflowFeature()
      .then((result) => {
        if (!cancelled) setEnabledState(result.enabled)
      })
      .catch(() => {
        // Treat a failed load as disabled — the safe default.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = useCallback(async (next: boolean) => {
    const result = await setWorkflowFeature(next)
    setEnabledState(result.enabled)
  }, [])

  return (
    <WorkflowFeatureContext.Provider value={{ enabled, loading, setEnabled }}>
      {children}
    </WorkflowFeatureContext.Provider>
  )
}

export const useWorkflowFeature = (): WorkflowFeatureValue => useContext(WorkflowFeatureContext)
