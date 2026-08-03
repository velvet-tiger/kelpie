import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { Shell } from '../components/Shell.tsx'
import { CompaniesPage } from '../pages/CompaniesPage.tsx'
import { CompanyDetail } from '../pages/CompanyDetail.tsx'
import { DealDetail } from '../pages/DealDetail.tsx'
import { DealStageSettingsPage } from '../pages/DealStageSettingsPage.tsx'
import { DealsPage } from '../pages/DealsPage.tsx'
import { DecisionsPage } from '../pages/DecisionsPage.tsx'
import { OpportunitiesPage } from '../pages/OpportunitiesPage.tsx'
import { OpportunityDetail } from '../pages/OpportunityDetail.tsx'
import { OpportunityStageSettingsPage } from '../pages/OpportunityStageSettingsPage.tsx'
import { PartnershipDetail } from '../pages/PartnershipDetail.tsx'
import { PartnershipStageSettingsPage } from '../pages/PartnershipStageSettingsPage.tsx'
import { PartnershipsPage } from '../pages/PartnershipsPage.tsx'
import { PeoplePage } from '../pages/PeoplePage.tsx'
import { PersonDetail } from '../pages/PersonDetail.tsx'
import { PlanningPage } from '../pages/PlanningPage.tsx'
import { CreateWorkspacePage } from '../pages/auth/CreateWorkspacePage.tsx'
import { SignInPage } from '../pages/auth/SignInPage.tsx'
import { UiExtensionProvider } from '../registry/UiExtensionProvider.tsx'
import { useModuleRoutes } from '../registry/context.ts'
import type { UiExtensions } from '../registry/registry.ts'
import { SessionGate } from './SessionGate.tsx'

/**
 * The whole application: providers, router, and the route table.
 *
 * It lives in `@kelpie/ui` rather than in `apps/kelpie` so the cloud assembly
 * gets the same application and differs only by the modules it registers. The
 * assembly's job is to build the registry and render this.
 *
 * Routes here are the ported pages. The mockup's other routes arrive with the
 * features behind them; module routes mount alongside through the registry.
 */

export interface KelpieAppProps {
  readonly extensions: UiExtensions
  /** Origin plus base path for the API. Defaults to same-origin `/v1`. */
  readonly baseUrl?: string
}

export function KelpieApp({ extensions, baseUrl }: KelpieAppProps): React.JSX.Element {
  return (
    <ApiProvider baseUrl={baseUrl}>
      <UiExtensionProvider extensions={extensions}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </UiExtensionProvider>
    </ApiProvider>
  )
}

function AppRoutes(): React.JSX.Element {
  const moduleRoutes = useModuleRoutes()

  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      <Route path="/create-workspace" element={<CreateWorkspacePage />} />

      <Route element={<SessionGate />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/people" replace />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="people/:id" element={<PersonDetail />} />
          <Route path="companies" element={<CompaniesPage />} />
          <Route path="companies/:id" element={<CompanyDetail />} />
          <Route path="deals" element={<DealsPage />} />
          <Route path="deals/settings" element={<DealStageSettingsPage />} />
          <Route path="deals/:id" element={<DealDetail />} />
          <Route path="opportunities" element={<OpportunitiesPage />} />
          <Route path="opportunities/settings" element={<OpportunityStageSettingsPage />} />
          <Route path="opportunities/:id" element={<OpportunityDetail />} />
          <Route path="partnerships" element={<PartnershipsPage />} />
          <Route path="partnerships/settings" element={<PartnershipStageSettingsPage />} />
          <Route path="partnerships/:id" element={<PartnershipDetail />} />
          <Route path="planning" element={<PlanningPage />} />
          <Route path="decisions" element={<DecisionsPage />} />
          {moduleRoutes.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/people" replace />} />
    </Routes>
  )
}
