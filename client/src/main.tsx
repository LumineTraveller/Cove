import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { applyTheme, readTheme } from './theme';
import { installAutoHideScrollbars } from './autoHideScrollbars';

// Apply the persisted palette before the first React paint to avoid a light
// flash when the user last chose dark mode.
applyTheme(readTheme());
installAutoHideScrollbars();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
