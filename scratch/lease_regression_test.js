import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const storage = {};
const gmStorage = {};
global.localStorage = {
  getItem: (key) => storage[key] || null,
  setItem: (key, value) => { storage[key] = String(value); },
  removeItem: (key) => { delete storage[key]; }
};
global.GM_getValue = (key, fallback) => Object.prototype.hasOwnProperty.call(gmStorage, key) ? gmStorage[key] : fallback;
global.GM_setValue = (key, value) => { gmStorage[key] = value; };
global.GM_registerMenuCommand = undefined;

const queueMod = await import('../src/core/queue.js');
const {
  WORKER_STAGE,
  addEpisodesToQueue,
  clearQueue,
  getQueue,
  updateQueueItem
} = queueMod;

function firstQueueItem() {
  const item = getQueue()[0];
  assert.ok(item, 'expected queue item');
  return item;
}

function addLeaseEpisode(unitId = 'u1') {
  return addEpisodesToQueue([{
    title: '1화',
    url: 'https://example.test/series/1',
    episodeNum: '0001',
    rootFolder: 'Series',
    unitId,
    destination: 'native'
  }], 'Series');
}

clearQueue();
assert.equal(addLeaseEpisode('u1'), 1);
let item = firstQueueItem();
updateQueueItem(item.id, {
  status: 'failed',
  stage: WORKER_STAGE.FAILED,
  progressPercent: 87,
  retryCount: 3,
  reported: true,
  startedAt: 11,
  lastProgressAt: 22,
  completedAt: 33,
  errorMsg: 'stalled'
});
assert.equal(addLeaseEpisode('u1'), 0);
item = firstQueueItem();
assert.equal(item.status, 'pending');
assert.equal(item.stage, WORKER_STAGE.INIT);
assert.equal(item.progressPercent, 0);
assert.equal(item.retryCount, 0);
assert.equal(item.reported, false);
assert.equal(item.startedAt, 0);
assert.equal(item.lastProgressAt, 0);
assert.equal(item.completedAt, 0);
assert.equal(item.errorMsg, '');

clearQueue();
addEpisodesToQueue([{ title: '1화', url: 'https://example.test/series/1', episodeNum: '0001' }], 'Series');
item = firstQueueItem();
updateQueueItem(item.id, { status: 'completed', stage: WORKER_STAGE.COMPLETED });
addEpisodesToQueue([{ title: '1화', url: 'https://example.test/series/1', episodeNum: '0001' }], 'Series');
assert.equal(firstQueueItem().status, 'completed');

const { Store } = await import('../server/lib/store.js');
const tempDir = mkdtempSync(join(tmpdir(), 'tokisync-lease-'));
try {
  const store = new Store(join(tempDir, 'state.json'));
  store.addUnits('Series', ['https://example.test/u1', 'https://example.test/u2'], 1000);
  const leased = store.lease('client-a', 2, 1100, 100);
  assert.equal(leased.length, 2);

  store.setClientReport('client-a', {
    current: [leased[0].id],
    queue: [{
      unitId: leased[0].id,
      status: 'processing',
      stage: 'STAGE_DOWNLOADING',
      progressPercent: 73,
      episodeNum: '0001',
      episodeTitle: '1화'
    }],
    logs: []
  }, 1150, 100);
  let units = store.listUnits(1150, '');
  const kept = units.find((u) => u.id === leased[0].id);
  const stale = units.find((u) => u.id === leased[1].id);
  assert.equal(kept.expiresAt, 1250);
  assert.equal(stale.expiresAt, 1200);
  const clientSnap = store.clients(1150, 30000).clients.find((c) => c.clientId === 'client-a');
  assert.equal(clientSnap.currentItems.length, 1);
  assert.equal(clientSnap.currentItems[0].stage, 'STAGE_DOWNLOADING');
  assert.equal(clientSnap.currentItems[0].progressPercent, 73);

  store.clients(1201, 30000);
  units = store.listUnits(1201, '');
  assert.equal(units.find((u) => u.id === leased[0].id).status, 'leased');
  assert.equal(units.find((u) => u.id === leased[1].id).status, 'pending');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

clearQueue();
console.log('lease regression checks passed');
process.exit(0);
