// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const log = /** @type {HTMLElement} */ (document.getElementById('log'));
  const form = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));

  function append(role, text, meta) {
    const entry = document.createElement('div');
    entry.className = `entry ${role}`;

    if (meta) {
      const label = document.createElement('div');
      label.className = 'meta';
      label.textContent = meta;
      entry.appendChild(label);
    }

    const body = document.createElement('pre');
    body.textContent = text;
    entry.appendChild(body);

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }

  function submit(text) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    append('user', trimmed);
    vscode.postMessage({ type: 'prompt', text: trimmed });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(input.value);
    input.value = '';
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'prompt':
        append('user', message.text, message.context ? message.context.file : undefined);
        vscode.postMessage({ type: 'prompt', text: message.text });
        break;
      case 'response':
        append('agent', message.text);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
