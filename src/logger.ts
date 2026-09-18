import { Cause, Inspectable, Layer, Logger, LogLevel, Schema, Option } from 'effect';
import type * as vscode from 'vscode';
import { readSetting } from './settings';

/**
 * Routes Effect's logging to an output channel. Debug and trace lines only appear while the
 * `uniAgent.verboseLogging` setting is on, which is read per line so it applies without a reload.
 */
export function outputChannelLogger(channel: vscode.LogOutputChannel): Layer.Layer<never> {
  const logger = Logger.make(({ logLevel, message, cause }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => Inspectable.toStringUnknown(part)).join(' ') + (Cause.isEmpty(cause) ? '' : `: ${Cause.pretty(cause)}`);
    switch (logLevel._tag) {
      case 'Fatal':
      case 'Error':
        return channel.error(text);
      case 'Warning':
        return channel.warn(text);
      case 'Info':
        return channel.info(text);
      case 'Debug':
      case 'Trace':
        if (Option.getOrElse(readSetting('verboseLogging', Schema.Boolean), () => false)) {
          channel.debug(text);
        }
    }
  });
  return Layer.merge(Logger.replace(Logger.defaultLogger, logger), Logger.minimumLogLevel(LogLevel.All));
}
