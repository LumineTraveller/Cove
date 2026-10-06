import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { installAutoHideScrollbars } from './autoHideScrollbars';
import { applyTheme, readTheme } from './features/settings/theme';
import { installViewportResizeState } from './viewportResize';
import './styles/index.css';

// Apply the persisted palette before the first React paint to avoid a light
// flash when the user last chose dark mode.
applyTheme(readTheme());
installAutoHideScrollbars();
installViewportResizeState();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
