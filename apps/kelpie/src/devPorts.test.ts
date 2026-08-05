import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { NoFreePortError, PORT_ATTEMPTS, findFreePort } from './devPorts.ts'

const opened: Server[] = []

function closeAll(): Promise<unknown[]> {
  return Promise.all(opened.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
}

/**
 * Occupies a port the operating system picks, so no case has to guess a number
 * that something else on the machine already holds.
 *
 * @param hostname The address to bind, or `undefined` for every interface.
 * @returns The port now in use.
 */
function occupyAnyPort(hostname: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    opened.push(server)

    const listening = (): void => {
      const address: string | AddressInfo | null = server.address()

      if (address === null || typeof address === 'string') {
        reject(new Error('the probe server reported no port'))
        return
      }

      resolve(address.port)
    }

    server.once('error', reject)

    if (hostname === undefined) {
      server.listen(0, listening)
    } else {
      server.listen(0, hostname, listening)
    }
  })
}

/** Takes a port the operating system assigned, then gives it straight back. */
async function borrowFreePort(hostname: string | undefined): Promise<number> {
  const port = await occupyAnyPort(hostname)
  await closeAll()

  return port
}

afterEach(async () => {
  await closeAll()
})

describe('findFreePort', () => {
  it('returns the preferred port when nothing holds it', async () => {
    const free = await borrowFreePort(undefined)

    expect(await findFreePort({ preferredPort: free, hostname: undefined, taken: [] })).toBe(free)
  })

  it('moves past a port that is actually in use', async () => {
    const occupied = await occupyAnyPort(undefined)

    const chosen = await findFreePort({ preferredPort: occupied, hostname: undefined, taken: [] })

    expect(chosen).toBeGreaterThan(occupied)
  })

  it('moves past a port held on the hostname it was asked about', async () => {
    // The regression this exists for: a port held on localhost alone, probed on
    // every interface, reads as free on macOS. Vite then dies on the port the
    // launcher just told it to use.
    const occupied = await occupyAnyPort('localhost')

    const chosen = await findFreePort({ preferredPort: occupied, hostname: 'localhost', taken: [] })

    expect(chosen).toBeGreaterThan(occupied)
  })

  it('moves past a port already assigned to another process this run', async () => {
    const free = await borrowFreePort(undefined)

    expect(await findFreePort({ preferredPort: free, hostname: undefined, taken: [free] })).toBeGreaterThan(free)
  })

  it('gives up once the whole range is spoken for, naming the range', async () => {
    const start = 3000
    const wholeRange = Array.from({ length: PORT_ATTEMPTS }, (_unused, offset) => start + offset)
    let thrown: unknown

    try {
      await findFreePort({ preferredPort: start, hostname: undefined, taken: wholeRange })
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(NoFreePortError)
    if (!(thrown instanceof NoFreePortError)) {
      throw thrown
    }

    expect(thrown.preferredPort).toBe(start)
    expect(thrown.lastPort).toBe(start + PORT_ATTEMPTS - 1)
    expect(thrown.message).toContain('3019')
  })

  it('stops the scan at the highest port rather than running past it', async () => {
    let thrown: unknown

    try {
      await findFreePort({ preferredPort: 65535, hostname: undefined, taken: [65535] })
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(NoFreePortError)
    if (!(thrown instanceof NoFreePortError)) {
      throw thrown
    }

    expect(thrown.lastPort).toBe(65535)
  })
})
