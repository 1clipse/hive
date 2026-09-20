import { useEffect, useState } from 'react'

import { getVersionInfo, type VersionInfo } from './api.js'

export const useVersionInfo = (provided?: VersionInfo | null): VersionInfo | null => {
  const [loaded, setLoaded] = useState<VersionInfo | null>(null)

  useEffect(() => {
    if (provided !== undefined) return
    let alive = true
    getVersionInfo()
      .then((info) => {
        if (alive) setLoaded(info)
      })
      .catch(() => {
        if (alive) setLoaded(null)
      })
    return () => {
      alive = false
    }
  }, [provided])

  return provided === undefined ? loaded : provided
}
