// Run only against the isolated local test-support/wrangler-background.jsonc.
import assert from 'node:assert/strict';
const base = 'http://localhost:4341';
const state = async () => (await fetch(`${base}/__proof/state`)).json();
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await state();
    if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Native worker did not reach expected state');
}
await fetch(`${base}/__proof/start`);
const paused = await until((s) => s.waiting);
const team = Object.values(paused.workshop.teams)[0];
const started = performance.now();
try {
  const response = await fetch(`${base}/api/workshops/native-proof/action`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'wid_session=native-session',
      'X-CSRF-Token': 'native-csrf',
      Origin: base,
    },
    body: JSON.stringify({
      action: 'node',
      payload: { teamId: team.id, id: 'initial', text: 'edited while sending' },
      revision: paused.workshop.revision,
      requestId: crypto.randomUUID(),
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const elapsed = Math.round(performance.now() - started);
  assert.equal((await state()).waiting, true, 'Edit must finish before Notion resumes');
  assert.equal(body.teams[team.id].nodes[0].text, 'edited while sending');
  console.log(`Native Durable Object: edit returned 200 in ${elapsed}ms while alarm was paused`);
} finally {
  await fetch(`${base}/__proof/release`);
}
const completed = await until((s) => !s.workshop.documentSync.syncing);
assert.deepEqual(completed.sentTexts, ['frozen text']);
assert.equal(completed.workshop.teams[team.id].nodes[0].text, 'edited while sending');
assert.equal(completed.workshop.documentSync.queued, true);
console.log('Frozen snapshot sent; newer edit remains saved and queued. No rollback.');
