import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { Shell } from '../components/Shell.tsx'
import { CompaniesPage } from '../pages/CompaniesPage.tsx'
import { CompanyDetail } from '../pages/CompanyDetail.tsx'
import { DealDetail } from '../pages/DealDetail.tsx'
import { DealStageSettingsPage } from '../pages/DealStageSettingsPage.tsx'
import { DealsPage } from '../pages/DealsPage.tsx'
import { DecisionsPage } from '../pages/DecisionsPage.tsx'
import { FormDetail } from '../pages/FormDetail.tsx'
import { FormsPage } from '../pages/FormsPage.tsx'
import { FundraisingPage } from '../pages/FundraisingPage.tsx'
import { HiringPage } from '../pages/HiringPage.tsx'
import { OpportunitiesPage } from '../pages/OpportunitiesPage.tsx'
import { OpportunityDetail } from '../pages/OpportunityDetail.tsx'
import { OpportunityStageSettingsPage } from '../pages/OpportunityStageSettingsPage.tsx'
import { PartnershipDetail } from '../pages/PartnershipDetail.tsx'
import { PartnershipStageSettingsPage } from '../pages/PartnershipStageSettingsPage.tsx'
import { PartnershipsPage } from '../pages/PartnershipsPage.tsx'
import { PeoplePage } from '../pages/PeoplePage.tsx'
import { PersonDetail } from '../pages/PersonDetail.tsx'
import { PlanningPage } from '../pages/PlanningPage.tsx'
import { RaiseDetail } from '../pages/RaiseDetail.tsx'
import { RaiseStageSettingsPage } from '../pages/RaiseStageSettingsPage.tsx'
import { RoleDetail } from '../pages/RoleDetail.tsx'
import { AccountLayout } from '../pages/account/AccountLayout.tsx'
import { PreferencesPage } from '../pages/account/PreferencesPage.tsx'
import { ProfilePage } from '../pages/account/ProfilePage.tsx'
import { SecurityPage } from '../pages/account/SecurityPage.tsx'
import { TeamPage } from '../pages/admin/TeamPage.tsx'
import { WorkspaceSettingsPage } from '../pages/admin/WorkspaceSettingsPage.tsx'
import { CreateWorkspacePage } from '../pages/auth/CreateWorkspacePage.tsx'
import { JoinPage } from '../pages/auth/JoinPage.tsx'
import { SignInPage } from '../pages/auth/SignInPage.tsx'
import { HandbookLayout } from '../pages/handbook/HandbookPage.tsx'
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
      {/* Outside the gate: an invitee may have no workspace yet, and this is how
          they get one. */}
      <Route path="/join" element={<JoinPage />} />

      <Route element={<SessionGate />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/people" replace />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="people/:id" element={<PersonDetail />} />
          <Route path="hiring" element={<HiringPage />} />
          <Route path="hiring/:id" element={<RoleDetail />} />
          <Route path="companies" element={<CompaniesPage />} />
          <Route path="companies/:id" element={<CompanyDetail />} />
          <Route path="deals" element={<DealsPage />} />
          <Route path="deals/settings" element={<DealStageSettingsPage />} />
          <Route path="deals/:id" element={<DealDetail />} />
          <Route path="opportunities" element={<OpportunitiesPage />} />
          <Route path="opportunities/settings" element={<OpportunityStageSettingsPage />} />
          <Route path="opportunities/:id" element={<OpportunityDetail />} />
          <Route path="fundraising" element={<FundraisingPage />} />
          <Route path="fundraising/settings" element={<RaiseStageSettingsPage />} />
          <Route path="fundraising/:id" element={<RaiseDetail />} />
          <Route path="partnerships" element={<PartnershipsPage />} />
          <Route path="partnerships/settings" element={<PartnershipStageSettingsPage />} />
          <Route path="partnerships/:id" element={<PartnershipDetail />} />
          <Route path="planning" element={<PlanningPage />} />
          <Route path="decisions" element={<DecisionsPage />} />
          <Route path="forms" element={<FormsPage />} />
          <Route path="forms/:id" element={<FormDetail />} />
          {/* The optional segment is the mockup's: /handbook opens the first page. */}
          <Route path="handbook" element={<HandbookLayout />} />
          <Route path="handbook/:pageId" element={<HandbookLayout />} />
          <Route path="admin/workspace" element={<WorkspaceSettingsPage />} />
          <Route path="admin/team" element={<TeamPage />} />
          {/* The mockup's own shape: /account opens the first tab. */}
          <Route path="account" element={<AccountLayout />}>
            <Route index element={<Navigate to="/account/profile" replace />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="preferences" element={<PreferencesPage />} />
          </Route>
          {moduleRoutes.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/people" replace />} />
    </Routes>
  )
}
