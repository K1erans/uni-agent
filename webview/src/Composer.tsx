import { Schema } from 'effect';
import { useRef, type ReactNode } from 'react';
import { Mode } from '../../src/agents/events';
import { ArrowUpIcon, BranchIcon, ChevronDownIcon, FolderIcon } from './icons';
import { MODE_DESCRIPTIONS, MODE_NAMES, permissionLabel } from './labels';
import type { SessionConfig } from './threadState';

interface ComposerProps {
  draft: string;
  rejection?: string;
  onDraftChange: (draft: string) => void;
  /** Sends the draft; the composer only calls it when `canSend`. */
  onSend: () => void;
  canSend: boolean;
  agentName: string;
  mode: Mode;
  /** Asks the extension to switch the thread's mode; undefined while no thread is shown. */
  onModeChange: ((mode: Mode) => void) | undefined;
  config: SessionConfig | undefined;
  workspace: string | null;
  branch: string | null;
}

/**
 * The prompt input, pinned below the conversation, and the session's settings. The settings show
 * what the agent really runs with; only the mode can be changed from here so far, and the others
 * are disabled.
 */
export function Composer({ draft, rejection, onDraftChange, onSend, canSend, agentName, mode, onModeChange, config, workspace, branch }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    if (canSend) {
      onSend();
      input.current?.focus();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="composer-box">
        <div className="composer-input-row">
          <textarea
            ref={input}
            className="composer-input"
            aria-label="Message"
            aria-describedby="composer-hint"
            placeholder={`Message ${agentName}…`}
            rows={3}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline. Enter that confirms an IME composition does neither.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="send-button" aria-label="Send" title="Send" disabled={!canSend}>
            <ArrowUpIcon size={21} />
          </button>
        </div>
        <div className="control-row control-row-session" role="group" aria-label="Session settings">
          <SettingControl name="Model" value={config?.model ?? 'Default model'} className="control-model" />
          <span className="spacer" />
          <SettingControl name="Reasoning" value="Default" />
          <span className="control-separator" aria-hidden="true" />
          <ModeControl mode={mode} onChange={onModeChange} agentName={agentName} config={config} />
        </div>
        <div className="control-row control-row-workspace" role="group" aria-label="Workspace">
          <SettingControl name="Workspace" value={workspace ?? 'No folder open'} icon={<FolderIcon size={13} />} />
          <span className="spacer" />
          {branch !== null && <SettingControl name="Branch" value={branch} icon={<BranchIcon size={12} />} />}
        </div>
      </div>
      <p id="composer-hint" className={rejection ? 'composer-hint composer-rejection' : 'composer-hint'} role={rejection ? 'alert' : undefined}>
        {rejection ?? 'Enter to send · Shift + Enter for a new line'}
      </p>
    </form>
  );
}

const MODES = Mode.literals;
const isMode = Schema.is(Mode);

interface ModeControlProps {
  mode: Mode;
  onChange: ((mode: Mode) => void) | undefined;
  agentName: string;
  config: SessionConfig | undefined;
}

/**
 * Picks the thread's mode, and can change it mid-thread. It shows the mode the extension reports,
 * so a switch the extension refuses (Full auto before the workspace opts in) leaves it unchanged.
 */
function ModeControl({ mode, onChange, agentName, config }: ModeControlProps) {
  const native = config ? ` ${agentName} runs it as ${permissionLabel(config.permissionMode)}.` : '';
  return (
    <label className="control control-mode" title={`Mode: ${MODE_NAMES[mode]}. ${MODE_DESCRIPTIONS[mode]}.${native}`}>
      <select
        className="control-select"
        aria-label="Mode"
        value={mode}
        disabled={onChange === undefined}
        onChange={(event) => {
          const next = event.target.value;
          if (isMode(next) && next !== mode) {
            onChange?.(next);
          }
        }}
      >
        {MODES.map((option) => (
          <option key={option} value={option}>
            {MODE_NAMES[option]}
          </option>
        ))}
      </select>
      <span className="control-value" aria-hidden="true">
        {MODE_NAMES[mode]}
      </span>
      <ChevronDownIcon size={10} className="control-chevron" />
    </label>
  );
}

interface SettingControlProps {
  name: string;
  value: string;
  icon?: ReactNode;
  className?: string;
}

/** A setting's current value, styled as the picker it will become; disabled until it can change. */
function SettingControl({ name, value, icon, className }: SettingControlProps) {
  return (
    <button
      type="button"
      className={className ? `control ${className}` : 'control'}
      disabled
      aria-label={`${name}: ${value}`}
      title={`${name}: ${value}. Changing it here isn’t supported yet.`}
    >
      {icon}
      <span className="control-value">{value}</span>
      <ChevronDownIcon size={10} className="control-chevron" />
    </button>
  );
}
