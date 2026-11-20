import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './design/shell.css';
import './design/workspaces.css';
import './design/assistant.css';
import './design/studio.css';
import './design/media.css';
import './design/dystopia.css';
import './design/activity.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
