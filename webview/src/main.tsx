import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './main.css';
import { vscode } from './vscodeApi';

const root = createRoot(document.getElementById('root')!);
flushSync(() => {
  root.render(
    <StrictMode>
      <App post={(message) => vscode.postMessage(message)} />
    </StrictMode>
  );
});
vscode.postMessage({ type: 'ready' });
