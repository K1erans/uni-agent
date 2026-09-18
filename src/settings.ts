import { Option, Schema } from 'effect';
import * as vscode from 'vscode';

/** Reads a `uniAgent.*` setting; a value that does not match the schema counts as unset. */
export function readSetting<A, I>(key: string, schema: Schema.Schema<A, I>): Option.Option<A> {
  return Schema.decodeUnknownOption(schema)(vscode.workspace.getConfiguration('uniAgent').get(key));
}
