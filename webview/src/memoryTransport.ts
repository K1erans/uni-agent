import type { ExtensionMessage, WebviewMessage } from '../../src/protocol';
import type { Delivery, Transport } from './transport';

/** A transport held in memory: whoever holds it plays the extension's side. */
export interface MemoryTransport extends Transport {
  /** Every message the webview has sent, oldest first. */
  readonly sent: ReadonlyArray<WebviewMessage>;
  /** Hands the webview a message, as the extension would post it. */
  deliver(message: ExtensionMessage): void;
  /** Hands the webview anything at all, for checking that what does not match the protocol is ignored. */
  deliverRaw(delivery: Delivery): void;
}

/**
 * Makes a transport that delivers synchronously, for tests and for driving the webview from a
 * backend outside VS Code. `onSend` hears each message the webview sends, after it is recorded.
 */
export function createMemoryTransport(onSend?: (message: WebviewMessage) => void): MemoryTransport {
  const sent: WebviewMessage[] = [];
  const listeners = new Set<(delivery: Delivery) => void>();
  const deliverRaw = (delivery: Delivery) => {
    for (const listener of listeners) {
      listener(delivery);
    }
  };
  return {
    sent,
    send: (message) => {
      sent.push(message);
      onSend?.(message);
    },
    listen: (onDelivery) => {
      // Wrapped, so each call listens once and stops once, even with the same function.
      const listener = (delivery: Delivery) => onDelivery(delivery);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deliver: (message) => deliverRaw({ data: message }),
    deliverRaw,
  };
}
