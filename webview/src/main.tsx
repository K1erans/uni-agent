import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './main.css';
import { createSidebarClient } from './sidebarClient';
import { draftStore, vscodeTransport } from './vscodeApi';

const client = createSidebarClient(vscodeTransport);
const root = createRoot(document.getElementById('root')!);
flushSync(() => {
  root.render(
    <StrictMode>
      <App client={client} drafts={draftStore} />
    </StrictMode>
  );
});
client.ready();
