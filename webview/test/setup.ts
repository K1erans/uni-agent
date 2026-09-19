import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans when Vitest globals are on; unmount between tests explicitly.
afterEach(cleanup);
