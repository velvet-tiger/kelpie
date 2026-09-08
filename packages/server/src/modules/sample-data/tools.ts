import { z } from 'zod'

import { requireWorkspaceId } from '../auth/actor.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { sampleDataResponse } from './routes.ts'
import type { SampleDataService } from './service.ts'

/**
 * `sample_data_install`: the MCP mirror of `POST /v1/workspaces/:id/sample-data`.
 *
 * Same admin check. Adds the fixture next to existing records. Fails when a
 * sample email or domain is already in the workspace. The tool takes no
 * arguments: it installs into the actor's own workspace.
 */

const installArgs = z.strictObject({})

export function registerSampleDataTools(
  mcp: McpToolRegistry,
  service: SampleDataService,
): void {
  mcp.tool({
    name: 'sample_data_install',
    description:
      'Populate this workspace with a small sample of companies, people, and other CRM records. Adds them next to existing records. Skips objects for modules that are switched off. Fails if a sample email or domain already exists.',
    inputSchema: installArgs,
    async invoke(_args, actor) {
      const counts = await service.install(actor, requireWorkspaceId(actor))

      return sampleDataResponse(counts)
    },
  })
}
