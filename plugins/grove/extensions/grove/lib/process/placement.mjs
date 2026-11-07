import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESTINATION_MODES = ['scratch', 'new-worktree', 'existing-worktree', 'read-only'];
export class PlacementError extends Error {}

export function localPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new PlacementError('workspace must be an absolute local folder.');
  let folder;
  try {
    folder = value.startsWith('file:') ? fileURLToPath(value) : value;
  } catch (err) {
    throw new PlacementError(`Invalid workspace URI: ${err.message}`);
  }
  if (!path.isAbsolute(folder)) throw new PlacementError('workspace must be absolute.');
  return path.normalize(folder);
}

export function destination(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !DESTINATION_MODES.includes(value.mode)) {
    throw new PlacementError(`destination is required: mode must be ${DESTINATION_MODES.join(', ')}.`);
  }
  if (Object.keys(value).some((k) => !['mode', 'workspace'].includes(k))) throw new PlacementError('destination accepts only mode and workspace.');
  if (value.mode === 'scratch') {
    if (value.workspace !== undefined) throw new PlacementError('scratch destination must omit workspace.');
    return { mode: 'scratch' };
  }
  return { mode: value.mode, workspace: localPath(value.workspace) };
}

export function continuationDestination(task) {
  const intent = destination(task.destination);
  const directory = task.directory ?? task.lastVerifiedPlacement?.directory;
  return directory
    ? { mode: 'existing-worktree', workspace: directory }
    : intent;
}

export function engineerPlacement(task, override) {
  const intent = override ? destination(override) : continuationDestination(task);
  return intent.mode === 'scratch' ? {} : { workspace: intent.workspace, worktree: intent.mode === 'new-worktree' };
}

export function reviewerPlacement(task, ticket) {
  if (!ticket.worktree) return {};
  const workspace = task.directory ?? task.lastVerifiedPlacement?.directory ?? task.destination?.workspace;
  if (!workspace) throw new PlacementError('A separate reviewer worktree needs a repository workspace.');
  return { workspace, worktree: true };
}
