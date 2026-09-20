import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

import { I18nProvider } from './i18n.js'
import { NotificationProvider } from './notifications/NotificationProvider.js'
import { RemoteFeatureProvider } from './remote/useRemoteFeature.js'
import { Toaster } from './ui/toast.js'
import { ToastProvider } from './ui/useToast.js'
import { WorkflowFeatureProvider } from './workflows/useWorkflowFeature.js'

export const AppProviders = ({ children }: { children: ReactNode }) => (
  <RadixTooltip.Provider delayDuration={250} skipDelayDuration={150}>
    <I18nProvider>
      <ToastProvider>
        <NotificationProvider>
          <WorkflowFeatureProvider>
            <RemoteFeatureProvider>
              {children}
              <Toaster />
            </RemoteFeatureProvider>
          </WorkflowFeatureProvider>
        </NotificationProvider>
      </ToastProvider>
    </I18nProvider>
  </RadixTooltip.Provider>
)
