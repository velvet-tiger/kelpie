import { describe, expect, it } from 'vitest'

import {
  asAiAuthor,
  createHostedAiActor,
  isAiAuthor,
  isBearerActor,
  originAfterTextEdit,
  requireSessionActor,
  writeOrigin,
} from './actor.ts'
import type { ApiKeyActor, OAuthActor, OAuthConnectionActor, SessionActor } from './actor.ts'

const session: SessionActor = {
  kind: 'session',
  userId: 'usr_1',
  sessionId: 'ses_1',
  workspaceId: 'wsp_1',
  role: 'owner',
  memberId: 'mem_1',
}

const workspaceKey: ApiKeyActor = {
  kind: 'api_key',
  apiKeyId: 'apik_1',
  userId: null,
  workspaceId: 'wsp_1',
  role: 'admin',
  scopes: [],
  memberId: null,
}

const oauth: OAuthActor = {
  kind: 'oauth',
  grantId: 'ogr_1',
  connectionId: 'ocn_1',
  clientId: 'client',
  userId: 'usr_1',
  workspaceId: 'wsp_1',
  role: 'owner',
  scopes: ['notes:write'],
  memberId: 'mem_1',
}

const oauthConnection: OAuthConnectionActor = {
  kind: 'oauth_connection',
  connectionId: 'ocn_1',
  clientId: 'client',
  userId: 'usr_1',
  workspaceId: null,
  role: null,
  scopes: ['notes:write'],
  memberId: null,
  workspaces: [],
}

describe('writeOrigin', () => {
  it('is member for a session', () => {
    expect(writeOrigin(session)).toBe('member')
  })

  it('is agent for every bearer credential', () => {
    expect(writeOrigin(workspaceKey)).toBe('agent')
    expect(writeOrigin({ ...workspaceKey, userId: 'usr_1', memberId: 'mem_1' })).toBe('agent')
    expect(writeOrigin(oauth)).toBe('agent')
    expect(writeOrigin(oauthConnection)).toBe('agent')
  })

  it('is ai for the hosted AI actor only', () => {
    expect(writeOrigin(createHostedAiActor('wsp_1'))).toBe('ai')
  })
})

describe('the hosted AI actor', () => {
  it('is a bearer actor and never a session', () => {
    const actor = createHostedAiActor('wsp_1')

    expect(isBearerActor(actor)).toBe(true)
    expect(() => requireSessionActor(actor)).toThrow('signed-in user')
  })

  it('cannot be copied from its fields: a key with the same id is an agent', () => {
    const lookalike: ApiKeyActor = { ...workspaceKey, apiKeyId: createHostedAiActor('wsp_1').apiKeyId }

    expect(isAiAuthor(lookalike)).toBe(false)
    expect(writeOrigin(lookalike)).toBe('agent')
  })

  it('cannot be made from JSON, whatever fields the JSON holds', () => {
    const parsed: unknown = JSON.parse(
      JSON.stringify({
        ...createHostedAiActor('wsp_1'),
        hostedAi: true,
        'Symbol(kelpie.hostedAi)': true,
        origin: 'ai',
      }),
    )
    // The cast stands in for a caller that got an object past the type checker.
    const forged = parsed as ApiKeyActor

    expect(isAiAuthor(forged)).toBe(false)
    expect(writeOrigin(forged)).toBe('agent')
  })
})

describe('asAiAuthor', () => {
  it('gives a copy that writes as ai and keeps the caller, and leaves the caller as it was', () => {
    const author = asAiAuthor(session)

    expect(writeOrigin(author)).toBe('ai')
    expect(author.memberId).toBe('mem_1')
    expect(author.kind).toBe('session')
    expect(writeOrigin(session)).toBe('member')
    expect(isAiAuthor(session)).toBe(false)
  })
})

describe('originAfterTextEdit', () => {
  it('leaves the origin alone when a member edits', () => {
    for (const origin of ['member', 'agent', 'ai', 'unknown'] as const) {
      expect(originAfterTextEdit(origin, session)).toBe(origin)
    }
  })

  it('makes a member row and an unknown row agent when a bearer credential edits', () => {
    for (const actor of [workspaceKey, oauth]) {
      expect(originAfterTextEdit('member', actor)).toBe('agent')
      expect(originAfterTextEdit('unknown', actor)).toBe('agent')
      expect(originAfterTextEdit('agent', actor)).toBe('agent')
    }
  })

  it('never moves a row away from ai', () => {
    expect(originAfterTextEdit('ai', workspaceKey)).toBe('ai')
    expect(originAfterTextEdit('ai', oauth)).toBe('ai')
    expect(originAfterTextEdit('ai', session)).toBe('ai')
  })

  it('makes any row ai when a model edits', () => {
    for (const origin of ['member', 'agent', 'unknown'] as const) {
      expect(originAfterTextEdit(origin, createHostedAiActor('wsp_1'))).toBe('ai')
      expect(originAfterTextEdit(origin, asAiAuthor(session))).toBe('ai')
    }
  })
})
