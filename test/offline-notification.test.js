import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOfflineNodes } from '../src/services/notification.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';

const NOW = 1_795_644_000_000;
const MINUTE = 60_000;

test('offline notifications use live receipts, distinguish D1 errors, and still alert and recover', async ({ mock }) => {
  const servers = ['Live', 'History error', 'Offline', 'New', 'Muted'].map((name, index) => ({
    id: String(index + 1), name, history_partition_id: index + 1,
    timestamp: name === 'New' ? NOW - MINUTE : NOW - 10 * MINUTE,
    offline_notify_disabled: name === 'Muted' ? 1 : '0'
  }));
  let updates = [{ serverId: '1', reportTs: NOW - MINUTE }];
  let status = 200;
  let alertState = {};
  const historyReads = [];
  const notifications = [];
  const db = {
    prepare(sql) {
      if (sql.includes("key = 'site_options'")) {
        return { first: async () => ({ value: JSON.stringify({
          jwt_secret: 'test-secret-test-secret-test-secret', tg_notify: '5',
          tg_bot_token: 'test-token', tg_chat_id: 'test-chat'
        }) }) };
      }
      if (sql === 'SELECT * FROM settings') return { all: async () => ({ results: [] }) };
      if (sql.includes('FROM servers')) return { all: async () => ({ results: servers }) };
      if (sql.includes('AS min_id')) return { first: async () => ({ min_id: 1 }) };
      if (sql.includes('FROM metrics_history') && sql.includes('WHERE server_id')) {
        return { bind: id => ({ first: async () => {
          historyReads.push(id);
          if (id === '2') throw new Error('test D1 read failed');
          return id === '4' ? null : { timestamp: NOW - 6 * MINUTE };
        } }) };
      }
      if (sql.includes("key = 'alert_state'")) {
        return { first: async () => ({ value: JSON.stringify(alertState) }) };
      }
      if (sql.includes('"alert_state"')) {
        return { bind: value => ({ run: async () => { alertState = JSON.parse(value); } }) };
      }
      assert.fail(`Unexpected query: ${sql}`);
    }
  };
  const env = {
    DB: db,
    METRICS_BROADCASTER: {
      idFromName: name => name,
      get: () => ({ fetch: async (url, options) => {
        assert.equal(url, 'http://internal/latest-report-updates');
        assert.deepEqual(JSON.parse(options.body).serverIds, ['1', '2', '3', '4']);
        return Response.json({ updates }, { status });
      } })
    }
  };

  clearSiteSettingsCache();
  clearServersListCache();
  mock.method(Date, 'now', () => NOW);
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  mock.method(globalThis, 'fetch', async (_url, options) => {
    notifications.push(JSON.parse(options.body).text);
    return new Response('ok');
  });

  await checkOfflineNodes(env);
  assert.deepEqual(historyReads, ['2', '3', '4']);
  assert.deepEqual(alertState, { 3: true });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /节点离线告警.*\n[\s\S]*Offline/);
  assert.doesNotMatch(notifications[0], /Live|History error|New|Muted/);

  status = 503;
  await checkOfflineNodes(env);
  assert.deepEqual(alertState, { 3: true });
  assert.equal(notifications.length, 1);

  status = 200;
  updates = [...updates, { serverId: '3', reportTs: NOW - MINUTE }];
  await checkOfflineNodes(env);
  assert.deepEqual(alertState, {});
  assert.equal(notifications.length, 2);
  assert.match(notifications[1], /节点恢复通知.*\n[\s\S]*Offline/);
});
