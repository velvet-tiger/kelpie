export { KelpieApp } from './app/KelpieApp.tsx'
export type { KelpieAppProps } from './app/KelpieApp.tsx'

export { ServiceStatus } from './ServiceStatus.tsx'
export type { ServiceStatusProps } from './ServiceStatus.tsx'

export { ApiError, createApiClient } from './api/client.ts'
export type { ApiClient, ApiClientOptions, Decoder, ErrorDetail, Page, QueryParameters } from './api/client.ts'

export { ApiProvider } from './api/ApiProvider.tsx'
export type { ApiProviderProps } from './api/ApiProvider.tsx'

export { useApiClient } from './api/context.ts'
export { toError } from './api/errors.ts'
export { createQueryClient } from './api/queryClient.ts'
export { createResourceHooks } from './api/resource.ts'
export type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  ResourceDefinition,
  ResourceHooks,
  UpdateArguments,
} from './api/resource.ts'

export {
  useCompanies,
  useCompany,
  useCreateCompany,
  useDeleteCompany,
  useUpdateCompany,
} from './api/resources/companies.ts'
export type { CompanyFilters, CreateCompanyInput } from './api/resources/companies.ts'

export {
  useCreatePerson,
  useDeletePerson,
  usePeople,
  usePerson,
  useUpdatePerson,
} from './api/resources/people.ts'
export type { CreatePersonInput, PeopleFilters } from './api/resources/people.ts'

export {
  useCreatePosition,
  useDeletePosition,
  usePositions,
  useUpdatePositionTitle,
} from './api/resources/positions.ts'
export type { PositionFilters, PositionTitleUpdate } from './api/resources/positions.ts'

export {
  MAX_PAGE_SIZE,
  useCreatePlanItem,
  useDeletePlanItem,
  usePlanItems,
  usePlanItemsForRecords,
  useRecordPlanItems,
  useUpdatePlanItem,
} from './api/resources/planItems.ts'
export type { PlanItemFilters } from './api/resources/planItems.ts'

export { useCreateWorkspace, useLogIn, useLogOut, useSession } from './api/resources/session.ts'
export type { SessionState } from './api/resources/session.ts'

export { fetchServiceHealth } from './api/health.ts'
export type { HealthRequestOptions, ServiceHealth } from './api/health.ts'

export { Chip } from './components/Chip.tsx'
export type { ChipProps, ChipTone } from './components/Chip.tsx'
export { DataTable } from './components/DataTable.tsx'
export type { Column, DataTableGroup, DataTableProps } from './components/DataTable.tsx'
export { DeleteRecord } from './components/DeleteRecord.tsx'
export type { DeleteRecordProps } from './components/DeleteRecord.tsx'
export { EntitySearch } from './components/EntitySearch.tsx'
export type { EntitySearchProps, SearchOption } from './components/EntitySearch.tsx'
export { InlineEdit } from './components/InlineEdit.tsx'
export type { InlineEditProps } from './components/InlineEdit.tsx'
export { FilterBar, PageHeader } from './components/PageHeader.tsx'
export type { FilterBarProps, PageHeaderProps } from './components/PageHeader.tsx'
export { PhonesField } from './components/PhonesField.tsx'
export type { PhonesFieldProps } from './components/PhonesField.tsx'
export { PlanAttention, RelatedPlanAttention } from './components/PlanAttention.tsx'
export type { PlanAttentionProps } from './components/PlanAttention.tsx'
export { PlanPanel } from './components/PlanPanel.tsx'
export type { PlanPanelProps } from './components/PlanPanel.tsx'
export { ErrorPanel, LoadingPanel, NotFoundPanel } from './components/QueryState.tsx'
export type { ErrorPanelProps } from './components/QueryState.tsx'
export { RecordTabs } from './components/RecordTabs.tsx'
export type { RecordTabDescriptor, RecordTabsProps } from './components/RecordTabs.tsx'
export { AddButton, SectionHeader } from './components/SectionHeader.tsx'
export type { AddButtonProps, SectionHeaderProps } from './components/SectionHeader.tsx'
export { Shell } from './components/Shell.tsx'
export { SidebarField } from './components/SidebarField.tsx'
export type { SidebarFieldProps } from './components/SidebarField.tsx'
export { SocialProfilesField } from './components/SocialProfilesField.tsx'
export type { SocialProfilesFieldProps } from './components/SocialProfilesField.tsx'
export { SummaryBlock } from './components/SummaryBlock.tsx'
export type { SummaryBlockProps } from './components/SummaryBlock.tsx'

export { CompaniesPage } from './pages/CompaniesPage.tsx'
export { CompanyDetail } from './pages/CompanyDetail.tsx'
export { PeoplePage } from './pages/PeoplePage.tsx'
export { PersonDetail } from './pages/PersonDetail.tsx'
export { PlanningPage } from './pages/PlanningPage.tsx'
export { CreateWorkspacePage } from './pages/auth/CreateWorkspacePage.tsx'
export { SignInPage } from './pages/auth/SignInPage.tsx'

export {
  DUE_BUCKETS,
  addDays,
  byDateThenTitle,
  dueBucketFor,
  isOpen,
  monthBounds,
  nextOpenByTarget,
  nextOpenPlanItem,
  planAttention,
  planStatusTone,
  toIsoDay,
  todayIso,
} from './lib/plan.ts'
export type { DueBucketId, PlanAttention as PlanAttentionSummary } from './lib/plan.ts'

export { applyTheme, getStoredTheme, resolveTheme, setStoredTheme, watchSystemTheme } from './lib/theme.ts'
export type { ThemePreference } from './lib/theme.ts'

export { INTEGRATION_CATEGORIES, NAV_SLOTS, RECORD_OBJECT_TYPES } from './registry/contributions.ts'
export type {
  DashboardCard,
  IntegrationCategory,
  IntegrationProvider,
  NavItem,
  NavSlot,
  RecordContext,
  RecordObjectType,
  RecordSidebarCard,
  RecordTab,
  RouteContribution,
} from './registry/contributions.ts'

export { defineOverridable } from './registry/overridable.ts'
export type { Overridable } from './registry/overridable.ts'

export { NO_UI_MODULES, UiModuleError, inSlotOrder, registerUiModules } from './registry/registry.ts'
export type { UiExtensions, UiModule, UiModuleContext } from './registry/registry.ts'

export {
  useDashboardCards,
  useIntegrationProviders,
  useModuleRoutes,
  useNavItems,
  useOverridable,
  useRecordSidebarCards,
  useRecordTabs,
  useUiExtensions,
} from './registry/context.ts'

export { UiExtensionProvider } from './registry/UiExtensionProvider.tsx'
export type { UiExtensionProviderProps } from './registry/UiExtensionProvider.tsx'
