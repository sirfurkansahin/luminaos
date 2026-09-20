export function planIncidentTransition({ probeOk, incidentState }) {
  if (typeof probeOk !== 'boolean') {
    throw new TypeError('probeOk must be a boolean.');
  }

  if (incidentState !== undefined && incidentState !== 'open' && incidentState !== 'closed') {
    throw new TypeError('incidentState must be open, closed, or undefined.');
  }

  if (!probeOk && incidentState === undefined) return 'create';
  if (!probeOk && incidentState === 'closed') return 'reopen';
  if (probeOk && incidentState === 'open') return 'close';
  return 'none';
}
