/**
 * Loads every core module's `KelpieEventMap` augmentation at the package entry.
 *
 * Each module declares its event payload types in `<module>/events.ts` through
 * `declare module '../../runtime/events.ts'`. Inside the monorepo those merge
 * because the source graph reaches every file. A consumer that installs
 * `@kelpie/server` from npm typechecks against `dist`, and declaration emit
 * keeps only the imports a file actually references. Nothing in `dist/index.d.ts`
 * referenced the per-module `events.d.ts` files, so `KelpieEventMap` stayed empty
 * for consumers and every `subscribe` handler saw `event.data: unknown`.
 *
 * These side-effect imports give `index.ts` one reference into each catalog. The
 * emitted `index.d.ts` carries them, so a consumer loads the augmentations and
 * gets a typed `event.data` without a cast at the read site.
 *
 * List only modules whose `events.ts` augments `KelpieEventMap`. A module that
 * publishes no events has no `events.ts` and does not belong here. Order mirrors
 * `coreModules` in `core.ts` for readability; it has no runtime effect.
 */

import './workspace/events.ts'
import './people/events.ts'
import './companies/events.ts'
import './positions/events.ts'
import './notes/events.ts'
import './lists/events.ts'
import './custom-fields/events.ts'
import './deals/events.ts'
import './opportunities/events.ts'
import './partnerships/events.ts'
import './raises/events.ts'
import './hiring/events.ts'
import './plans/events.ts'
import './decisions/events.ts'
import './handbook/events.ts'
import './forms/events.ts'
import './import-export/events.ts'
