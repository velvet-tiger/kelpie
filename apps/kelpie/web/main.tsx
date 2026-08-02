import { ServiceStatus } from '@kelpie/ui'
import '@kelpie/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Expected an element with id "root" in index.html')
}

createRoot(container).render(
  <StrictMode>
    <ServiceStatus healthUrl="/healthz" />
  </StrictMode>,
)
