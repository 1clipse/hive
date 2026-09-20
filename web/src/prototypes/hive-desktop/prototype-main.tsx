import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { HiveDesktopPrototype } from './HiveDesktopPrototype.js'
import './prototype.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Prototype root not found')
}

createRoot(root).render(
  <StrictMode>
    <HiveDesktopPrototype />
  </StrictMode>
)
