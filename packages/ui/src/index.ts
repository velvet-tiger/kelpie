export { ServiceStatus } from './ServiceStatus.tsx'
export type { ServiceStatusProps } from './ServiceStatus.tsx'

export { ApiError, createApiClient } from './api/client.ts'
export type { ApiClient, ApiClientOptions, Decoder, ErrorDetail, Page, QueryParameters } from './api/client.ts'

export { fetchServiceHealth } from './api/health.ts'
export type { HealthRequestOptions, ServiceHealth } from './api/health.ts'

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
