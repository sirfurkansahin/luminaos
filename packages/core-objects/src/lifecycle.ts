import type { Lifecycle } from './lumina-object.js';

export type LifecycleAction = 'archive' | 'restore' | 'softDelete';

/**
 * Per ADR-0003 "Yaşam döngüsü durum makinesi":
 *  - archive:    active -> archived                         (only)
 *  - restore:    archived -> active  OR  deleted -> active   (only)
 *  - softDelete: active -> deleted   OR  archived -> deleted (only)
 */
export function canTransition(from: Lifecycle, action: LifecycleAction): boolean {
  if (action === 'archive') {
    return from === 'active';
  }

  if (action === 'restore') {
    return from === 'archived' || from === 'deleted';
  }

  // action === 'softDelete' (LifecycleAction is exhaustively narrowed to this
  // by this point, so no further branch/default is reachable).
  return from === 'active' || from === 'archived';
}
