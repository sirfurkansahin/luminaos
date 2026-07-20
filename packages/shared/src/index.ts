export interface HealthCheckPayload {
  status: 'ok';
}

export function buildHealthCheckPayload(): HealthCheckPayload {
  return { status: 'ok' };
}
