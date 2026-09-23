import type { WebviewMessage } from '../../src/protocol';

/** One message as it arrived from the extension, not yet decoded. A DOM `MessageEvent` is one. */
export interface Delivery {
  readonly data: unknown;
}

/**
 * How the sidebar reaches the extension: it sends webview messages and hears whatever comes back.
 * In VS Code that is the webview API; tests and other hosts use `createMemoryTransport`.
 */
export interface Transport {
  send(message: WebviewMessage): void;
  /** Calls `onDelivery` for each message that arrives, until the returned function is called. */
  listen(onDelivery: (delivery: Delivery) => void): () => void;
}
