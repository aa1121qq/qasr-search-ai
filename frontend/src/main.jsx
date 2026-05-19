import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Maintenance from './Maintenance.jsx'

// 🔧 Maintenance flag — يُتحكَّم به عبر متغيّر بيئة في Vercel
// VITE_MAINTENANCE_MODE=true  → يعرض صفحة "تحت التطوير"
// VITE_MAINTENANCE_MODE=false (أو غير مضبوط) → يعرض التطبيق العادي
const isMaintenanceMode = import.meta.env.VITE_MAINTENANCE_MODE === 'true'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isMaintenanceMode ? <Maintenance /> : <App />}
  </StrictMode>,
)
