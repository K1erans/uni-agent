import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom's ElementInternals lacks the form-associated API that @vscode-elements form controls call.
const internals: Partial<ElementInternals> = ElementInternals.prototype;
internals.setFormValue ??= () => {};
internals.setValidity ??= () => {};

// Testing Library only auto-cleans when Vitest globals are on; unmount between tests explicitly.
afterEach(cleanup);
