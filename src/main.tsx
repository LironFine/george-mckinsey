import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import MobileDesktopHint from './components/MobileDesktopHint';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <MobileDesktopHint />
  </StrictMode>,
);
