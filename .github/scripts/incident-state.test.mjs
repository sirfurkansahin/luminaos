import assert from 'node:assert/strict';
import test from 'node:test';

import { planIncidentTransition } from './incident-state.mjs';

test('creates the first incident and does not duplicate an open incident', () => {
  assert.equal(planIncidentTransition({ probeOk: false, incidentState: undefined }), 'create');
  assert.equal(planIncidentTransition({ probeOk: false, incidentState: 'open' }), 'none');
});

test('reopens a recovered incident when production fails again', () => {
  assert.equal(planIncidentTransition({ probeOk: false, incidentState: 'closed' }), 'reopen');
});

test('closes an open incident on recovery and otherwise does nothing', () => {
  assert.equal(planIncidentTransition({ probeOk: true, incidentState: 'open' }), 'close');
  assert.equal(planIncidentTransition({ probeOk: true, incidentState: 'closed' }), 'none');
  assert.equal(planIncidentTransition({ probeOk: true, incidentState: undefined }), 'none');
});

test('rejects unknown inputs', () => {
  assert.throws(() => planIncidentTransition({ probeOk: 'yes' }), /boolean/);
  assert.throws(
    () => planIncidentTransition({ probeOk: true, incidentState: 'unknown' }),
    /incidentState/,
  );
});
