import { appUrlConfigSchema } from '../../lib/appUrl.ts'
import { createEgressGuard, egressConfigSchema } from '../../lib/egress.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { MCP_ROUTE_PREFIX } from '../mcp/paths.ts'
import type { Fetch } from './clients.ts'
import { OAUTH_ROUTE_PREFIX } from './paths.ts'
import { createProtocolHandlers, mountOAuthRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { DEFAULT_SCOPES, createOAuthService } from './service.ts'

/**
 * OAuth 2.1 for MCP: Kelpie as its own authorization server, so a client
 * that connects only through OAuth (a Claude.ai connector, say) can reach a
 * workspace without anyone pasting a key.
 *
 * Core, and structural, because MCP is core: a self-hoster wants to add their
 * install to such a client as much as a cloud customer does. No vendor is
 * named here; other products call Kelpie, not the reverse.
 *
 * Tokens reach `/mcp` and nothing else. `modules/auth/credentials.ts` turns an
 * access token into an `OAuthActor` there, and answers `401` to one on `/v1`.
 */

export interface OAuthModuleOptions {
  /** Injected so tests can serve a Client ID Metadata Document without a network. */
  readonly fetch?: Fetch
  /** Injected only so tests can pin secrets. */
  readonly newToken?: () => string
}

export function createOAuthModule(migrationsDirectory: string, options: OAuthModuleOptions = {}): KelpieModule {
  return {
    id: 'oauth',
    requires: ['auth', 'workspace'],
    structural: true,

    register(context) {
      const appBaseUrl = context.appBaseUrl ?? context.config(appUrlConfigSchema).APP_BASE_URL
      const service = createOAuthService({
        db: context.db,
        createId: context.createId,
        now: context.now,
        appBaseUrl,
        egress: createEgressGuard(context.config(egressConfigSchema)),
        fetch: options.fetch ?? ((input, init) => fetch(input, init)),
        ...(options.newToken === undefined ? {} : { newToken: options.newToken }),
      })
      const handlers = createProtocolHandlers(service)

      context.schema(schema, migrationsDirectory)

      // RFC 9728 puts the document for `https://host/mcp` at
      // `/.well-known/oauth-protected-resource/mcp`. The bare path answers too,
      // for clients that look there first.
      context.appRoute('GET', `/.well-known/oauth-protected-resource${MCP_ROUTE_PREFIX}`, handlers.protectedResource)
      context.appRoute('GET', '/.well-known/oauth-protected-resource', handlers.protectedResource)
      context.appRoute('GET', '/.well-known/oauth-authorization-server', handlers.authorizationServer)
      context.appRoute('GET', `${OAUTH_ROUTE_PREFIX}/authorize`, handlers.authorize)
      context.appRoute('POST', `${OAUTH_ROUTE_PREFIX}/token`, handlers.token)
      context.appRoute('POST', `${OAUTH_ROUTE_PREFIX}/register`, handlers.register)
      context.appRoute('POST', `${OAUTH_ROUTE_PREFIX}/revoke`, handlers.revoke)

      context.routes((router) => {
        mountOAuthRoutes(router, { db: context.db, now: context.now, service })
      })

      context.provideMcpAuthorization({
        resourceMetadataUrl: service.endpoints.resourceMetadataUrl,
        defaultScopes: DEFAULT_SCOPES,
      })

      // A grant acts as its user, so it ends with their membership. The
      // credential resolver also checks the membership on every request, so a
      // missed event leaves a dead row, not a working token.
      context.events.subscribe('workspace.member.removed', async (event) => {
        await service.removeMemberGrants(event.workspaceId, event.data.userId)
      })

      return Promise.resolve()
    },
  }
}
