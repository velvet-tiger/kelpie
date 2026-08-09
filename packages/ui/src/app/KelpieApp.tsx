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
import { NotFoundPage } from '../pages/NotFoundPage.tsx'
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
import { DataPage } from '../pages/admin/DataPage.tsx'
import { McpPage } from '../pages/admin/McpPage.tsx'
import { ModulesPage } from '../pages/admin/ModulesPage.tsx'
import { TeamPage } from '../pages/admin/TeamPage.tsx'
import { WebhooksPage } from '../pages/admin/WebhooksPage.tsx'
import { WorkspaceSettingsPage } from '../pages/admin/WorkspaceSettingsPage.tsx'
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage.tsx'
import { JoinPage } from '../pages/auth/JoinPage.tsx'
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage.tsx'
import { SignInPage } from '../pages/auth/SignInPage.tsx'
import { SignUpPage } from '../pages/auth/SignUpPage.tsx'
import { DashboardPage } from '../pages/dashboard/DashboardPage.tsx'
import { HandbookLayout } from '../pages/handbook/HandbookPage.tsx'
import { HandbookStepPage } from '../pages/onboarding/HandbookStepPage.tsx'
import { InvitesStepPage } from '../pages/onboarding/InvitesStepPage.tsx'
import { WorkspaceStepPage } from '../pages/onboarding/WorkspaceStepPage.tsx'
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
      {/* Signed out, or on the way to being signed in. Route names are the
          mockup's. */}
      <Route path="/login" element={<SignInPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/* Outside the gate: an invitee may have no workspace yet, and this is how
          they get one. Same for the first onboarding step, which is what the
          gate sends an account with no workspace to. */}
      <Route path="/join" element={<JoinPage />} />
      <Route path="/onboarding/workspace" element={<WorkspaceStepPage />} />

      <Route element={<SessionGate />}>
        {/* Inside the gate and outside the Shell: both steps need the workspace
            that step 1 created, and neither is a place to start navigating the
            app from. */}
        <Route path="/onboarding/invites" element={<InvitesStepPage />} />
        <Route path="/onboarding/handbook" element={<HandbookStepPage />} />

        <Route element={<Shell />}>
          {/* The mockup's default route, and where the shell's wordmark goes. */}
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
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
          <Route path="admin/data" element={<DataPage />} />
          <Route path="admin/mcp" element={<McpPage />} />
          <Route path="admin/webhooks" element={<WebhooksPage />} />
          <Route path="admin/modules" element={<ModulesPage />} />
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
          {/* Last so every named route above wins first. Nested here rather than
              outside the gate, so a signed-out visitor is redirected to /login by
              `SessionGate` before this ever renders, and a signed-in one keeps the
              Shell's nav instead of landing on a bare page with no way back in. */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
