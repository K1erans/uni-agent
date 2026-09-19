import { Option, Schema } from 'effect';
import type { WebviewMessage } from '../../src/protocol';
import type { DraftStore } from './App';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  /** Whatever this webview last saved, or undefined; decoded before use, as an older build may have saved it. */
  getState(): object | undefined;
  setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** The webview's handle to the extension. `acquireVsCodeApi` may only be called once per page. */
export const vscode = acquireVsCodeApi();

/** What the webview keeps while VS Code disposes it (the sidebar hidden): unsent drafts by thread. */
const WebviewState = Schema.Struct({ drafts: Schema.Array(Schema.Tuple(Schema.String, Schema.String)) });
type WebviewState = typeof WebviewState.Type;

const decodeState = Schema.decodeUnknownOption(WebviewState);

export const draftStore: DraftStore = {
  load: () => Option.match(decodeState(vscode.getState()), { onNone: () => new Map(), onSome: (state) => new Map(state.drafts) }),
  save: (drafts) => vscode.setState({ drafts: [...drafts] }),
};
