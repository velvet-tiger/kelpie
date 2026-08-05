import { createServer } from 'node:net'

/**
 * Choosing a free port for a development process to be told to use.
 *
 * Nothing here runs in production, and the service does not import it. The API
 * binds the `PORT` it is given and fails when that port is taken, which is the
 * behaviour a deployment wants: a server that quietly moved is a server nothing
 * can reach. Picking the number is the local launcher's job, and it happens
 * before either process starts.
 */

/** How many consecutive ports to try, counting the preferred one. */
export const PORT_ATTEMPTS = 20

const HIGHEST_PORT = 65535

export interface FreePortSearch {
  /** Where the scan starts. */
  readonly preferredPort: number
  /**
   * The address the process will bind, or `undefined` for every interface.
   *
   * It has to match, because macOS lets a bind to every interface succeed while
   * another process holds one specific address on the same port. Probing every
   * interface reported 5173 free while the Vite dev server, which binds
   * localhost, could not have it.
   */
  readonly hostname: string | undefined
  /**
   * Ports already assigned during this run. The operating system still reports
   * them as free, because nothing has bound them yet.
   */
  readonly taken: readonly number[]
}

/** Thrown when every port in the scanned range is already in use. */
export class NoFreePortError extends Error {
  readonly preferredPort: number
  readonly lastPort: number

  constructor(preferredPort: number, lastPort: number) {
    super(`No free port between ${preferredPort} and ${lastPort}. Every one of them is in use.`)
    this.name = 'NoFreePortError'
    this.preferredPort = preferredPort
    this.lastPort = lastPort
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }

  return undefined
}

/**
 * Binds a port and immediately lets it go again.
 *
 * @param port The port to test.
 * @param hostname The address to bind, or `undefined` for every interface.
 * @returns `true` when the port was free.
 * @throws Anything other than `EADDRINUSE`. `EACCES` on a privileged port is
 *   not a reason to try the next port up, which would fail the same way.
 */
function isPortFree(port: number, hostname: string | undefined): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer()

    probe.once('error', (error: Error) => {
      if (errorCode(error) === 'EADDRINUSE') {
        resolve(false)
        return
      }

      reject(error)
    })

    const listening = (): void => {
      probe.close(() => resolve(true))
    }

    if (hostname === undefined) {
      probe.listen(port, listening)
    } else {
      probe.listen(port, hostname, listening)
    }
  })
}

/**
 * Returns the preferred port, or the next free port above it.
 *
 * There is a gap between testing a port and the child process binding it, so
 * this narrows the odds of a collision rather than removing them. That is the
 * right trade for a launcher and the wrong one for a service, which is why the
 * service still fails outright on a port it cannot have.
 *
 * @throws NoFreePortError when the whole range is spoken for.
 */
export async function findFreePort({ preferredPort, hostname, taken }: FreePortSearch): Promise<number> {
  const lastPort = Math.min(preferredPort + PORT_ATTEMPTS - 1, HIGHEST_PORT)

  for (let port = preferredPort; port <= lastPort; port += 1) {
    if (!taken.includes(port) && (await isPortFree(port, hostname))) {
      return port
    }
  }

  throw new NoFreePortError(preferredPort, lastPort)
}
