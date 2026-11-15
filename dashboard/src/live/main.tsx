import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import LiveApp from './LiveApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveApp />
  </StrictMode>,
)
