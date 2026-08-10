import { KelpieApp, registerUiModules } from '@kelpie/ui'
import '@kelpie/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { uiModules } from '../kelpie.ui.config.ts'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Expected an element with id "root" in index.html')
}

// Registration is build-time and happens once, above the root. A module
// clashing with another fails here, at startup, rather than as a tab somebody
// notices is missing a week later.
const extensions = registerUiModules(uiModules)

createRoot(container).render(
  <StrictMode>
    <KelpieApp extensions={extensions} />
  </StrictMode>,
)
