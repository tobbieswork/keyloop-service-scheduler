import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createApiClient } from './api';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={createApiClient()} />
  </StrictMode>,
);
