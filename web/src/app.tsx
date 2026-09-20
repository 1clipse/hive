import { AppInner } from './AppInner.js'
import { AppProviders } from './AppProviders.js'
import { LayoutModeProvider } from './mobile/layout-mode.js'

export const App = () => (
  <LayoutModeProvider>
    <AppProviders>
      <AppInner />
    </AppProviders>
  </LayoutModeProvider>
)
