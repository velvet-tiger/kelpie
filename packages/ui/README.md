# @kelpie/ui

The React UI for [Kelpie](https://github.com/velvet-tiger/kelpie).

Kelpie is an open-source, agent-native CRM and company brain. This package holds the components, the pages, the typed API client, and the extension registry that an assembly composes modules through. It talks to the same public API agents use; there are no private UI-only endpoints.

## Install

```bash
npm install @kelpie/ui react react-dom
```

React 19 is a peer dependency, so it resolves to your copy rather than a second one.

## Use

```tsx
import { KelpieApp, registerUiModules } from '@kelpie/ui'
import '@kelpie/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { uiModules } from './kelpie.ui.config.ts'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <KelpieApp extensions={registerUiModules(uiModules)} />
  </StrictMode>,
)
```

Registration happens once, above the root, at build time. A module clashing with another fails at startup rather than as a tab someone notices is missing a week later.

## Styling

`@kelpie/ui/styles.css` imports Tailwind CSS 4 and declares the theme tokens every component uses. Your build needs to process it with Tailwind, for example through `@tailwindcss/vite`.

The stylesheet carries an `@source` directive pointing at the components beside it, which is how Tailwind finds the classes they name. Tailwind skips `node_modules` when it detects sources by itself, so that directive is doing real work. If it ever stops, the build still succeeds and every page renders unstyled.

Colours are tokens rather than literals, so light and dark are the same markup against a different `:root` block, and a module replacing a component inherits the palette.

## Licence

AGPL-3.0-only.
