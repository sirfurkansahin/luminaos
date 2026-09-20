import assert from 'node:assert/strict';

const origin = 'http://127.0.0.1:3000';
const mode = process.env.SMOKE_MODE ?? 'seed';
const credentials = {
  email: process.env.SMOKE_EMAIL,
  password: process.env.SMOKE_PASSWORD,
};
const workspaceName = process.env.SMOKE_WORKSPACE;

assert(credentials.email, 'SMOKE_EMAIL is required');
assert(credentials.password, 'SMOKE_PASSWORD is required');
assert(workspaceName, 'SMOKE_WORKSPACE is required');

const healthResponse = await fetch(`${origin}/health`);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.status, 'ok');

const jsonHeaders = { 'Content-Type': 'application/json' };

if (mode === 'seed') {
  const registered = await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(credentials),
  });
  assert.equal(registered.status, 201);

  const cookie = registered.headers.get('set-cookie');
  assert(cookie?.includes('HttpOnly'));
  assert(cookie.includes('Secure'));
  const authenticatedHeaders = {
    ...jsonHeaders,
    Cookie: cookie.split(';')[0],
  };

  const created = await fetch(`${origin}/workspaces`, {
    method: 'POST',
    headers: authenticatedHeaders,
    body: JSON.stringify({ name: workspaceName }),
  });
  assert.equal(created.status, 201);
  const { workspace } = await created.json();

  const read = await fetch(`${origin}/workspaces/${workspace.id}`, {
    headers: authenticatedHeaders,
  });
  assert.equal(read.status, 200);

  const denied = await fetch(`${origin}/workspaces/${workspace.id}`);
  assert.equal(denied.status, 401);

  console.log(
    'PASS: health, registration, secure cookie, workspace write/read, unauthorized denial',
  );
} else if (mode === 'verify-persistence') {
  const login = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);

  const cookie = login.headers.get('set-cookie');
  assert(cookie, 'Login did not return a session cookie');
  const me = await fetch(`${origin}/me`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert(body.workspaces.some((workspace) => workspace.name === workspaceName));

  console.log('PASS: login and workspace data survived database and API container recreation');
} else {
  throw new Error(`Unknown SMOKE_MODE: ${mode}`);
}
