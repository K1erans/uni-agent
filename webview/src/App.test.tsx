import type { VscodeButton } from '@vscode-elements/elements';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders an empty thread with a composer', () => {
    render(<App />);

    expect(screen.getByText('No messages yet.')).toBeTruthy();
    expect(document.querySelector('vscode-textarea')).not.toBeNull();
    expect(document.querySelector<VscodeButton>('vscode-button')?.disabled).toBe(true);
  });
});
