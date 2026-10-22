// Offline checks execute the exact Code node bodies from workflow.json.
// Optional database tests: STRATA_TEST_MYSQL=/path/to/mysql STRATA_TEST_SOCKET=/path/to/socket node test.js
// Database mode creates and drops an isolated, uniquely named test database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflow.json')));
const node = name => workflow.nodes.find(n => n.name === name);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function run(name, input, sources = {}, date = '2026-10-21 16:45:00.000') {
  const now = { setZone(zone) { assert.equal(zone, 'Asia/Hong_Kong'); return this; },
    toFormat(format) { assert.equal(format, 'yyyy-MM-dd HH:mm:ss.SSS'); return date; } };
  return new Function('$input', '$', '$now', node(name).parameters.jsCode)(
    { all: () => input.map(json => ({ json })) },
    name => ({ first: () => ({ json: sources[name] }) }), now,
  )[0].json;
}
const metric = (a = '100', b = '20') => `# TYPE unrelated gauge\nunrelated 123\nllamacpp:prompt_tokens_total{model="any-model"} ${a}\nllamacpp:tokens_predicted_total ${b}\n`;
function parse(text = metric(), before = 1790000000, after = before, date) {
  return run('Code - Parse Metrics', [{}], {
    'Tracker Configuration': { instance_id: 'strata-p40', input_metric: 'llamacpp:prompt_tokens_total', output_metric: 'llamacpp:tokens_predicted_total' },
    'HTTP - Strata Metrics': { data: text },
    'HTTP - Status Before Metrics': { started: before },
    'HTTP - Strata Status': { started: after },
  }, date);
}
function calc(current, previous = {}) {
  return run('Code - Calculate Usage', [previous], { 'Code - Parse Metrics': current });
}
const current = parse();
const previous = { id: 1, server_started_at: current.server_started_at, input_total: 90, output_total: 15 };
test('empty database establishes baseline', () => {
  const r = calc(current); assert.equal(r.input_delta, 0); assert.equal(r.output_delta, 0); assert.equal(r.previous_id, 0);
});
test('increasing counters', () => {
  const r = calc(current, previous); assert.equal(r.input_delta, 10); assert.equal(r.output_delta, 5);
});
test('unchanged counters still produce a snapshot', () => {
  const r = calc(current, { ...previous, input_total: 100, output_total: 20 });
  assert.equal(r.input_delta, 0); assert.equal(r.output_delta, 0);
});
test('restart counts new session', () => {
  const r = calc(current, { ...previous, server_started_at: 1780000000, input_total: 9999 });
  assert.equal(r.input_delta, 100); assert.equal(r.output_delta, 20);
});
test('either counter decreasing is rejected', () => {
  for (const p of [{ input_total: 101 }, { output_total: 21 }])
    assert.throws(() => calc(current, { ...previous, ...p }), /Counter inconsistency/);
});
test('consecutive executions do not double count', () => {
  const r = calc(current, previous);
  const next = calc(current, { ...r, id: 2 });
  assert.equal(next.input_delta + next.output_delta, 0);
});
test('midnight observation retains its actual timestamp', () => {
  const r = calc(parse(metric(), undefined, undefined, '2026-10-22 00:02:00.000'), previous);
  assert.equal(r.recorded_at.slice(0, 10), '2026-10-22'); assert.equal(r.input_delta, 10);
});
test('missing, malformed, negative, duplicate and overflow metrics rejected', () => {
  for (const text of ['', 'unrelated 0', metric('-1'), metric('NaN'), metric('1.5'), metric('1e3'), metric('18446744073709551616'), metric() + metric()])
    assert.throws(() => parse(text));
  assert.throws(() => parse({}));
});
test('comments, optional labels and sample timestamps', () => {
  assert.equal(parse(metric('100', '20 1790000000000')).output_total, 20);
  assert.equal(parse(metric().replace('{model="any-model"}', '')).input_total, 100);
});
test('startup timestamp validation and restart during sample', () => {
  for (const value of [0, -1, '1790000000', null, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parse(metric(), value, value));
  assert.throws(() => parse(metric(), 1790000000, 1790000001), /restarted while sampling/);
  assert.throws(() => run('Code - Parse Metrics', [{}], {
    'Tracker Configuration': {}, 'HTTP - Strata Metrics': { data: metric() },
    'HTTP - Status Before Metrics': {}, 'HTTP - Strata Status': {},
  }), /status.started/);
});
test('unsigned BIGINT precision preserved', () => {
  const big = parse(metric('18446744073709551615', '0'));
  assert.equal(big.input_total, '18446744073709551615');
  assert.equal(calc(big, { ...previous, input_total: '18446744073709551614', output_total: 0 }).input_delta, 1);
  assert.throws(() => calc(parse(metric('18446744073709551615', '1')), { ...previous, server_started_at: 1 }), /total_delta/);
});
test('malformed previous snapshot fails closed', () => {
  assert.throws(() => calc(current, { success: true }));
  assert.throws(() => calc(current, { ...previous, input_total: Number.MAX_SAFE_INTEGER + 1 }));
});
test('workflow topology, credentials, schedule and error settings', () => {
  assert.equal(workflow.active, true);
  assert.equal(workflow.settings.timezone, 'Asia/Hong_Kong');
  const interval = node('Every 5 Minutes').parameters.rule.interval[0];
  assert.equal(interval.field, 'minutes');
  assert.equal(interval.minutesInterval ?? 5, 5); // n8n omits the default interval from exports.
  assert.equal(node('MySQL - Get Latest Snapshot').alwaysOutputData, true);
  const reachable = new Set();
  function visit(name) { if (reachable.has(name)) return; reachable.add(name);
    for (const branch of workflow.connections[name]?.main || []) for (const edge of branch) { assert.ok(node(edge.node)); visit(edge.node); } }
  visit('Every 5 Minutes'); assert.equal(reachable.size, workflow.nodes.length);
  for (const n of workflow.nodes) {
    assert.ok(!n.continueOnFail && !n.retryOnFail && !n.disabled);
    if (n.type.endsWith('.httpRequest')) {
      assert.equal(n.parameters.genericAuthType, 'httpBearerAuth');
      assert.equal(n.parameters.options.timeout, 15000);
      assert.ok(!n.parameters.options.response.response.neverError);
    }
    if (n.type.endsWith('.mySql')) {
      assert.equal(n.typeVersion, 2.5); assert.equal(n.parameters.options.queryBatching, 'single');
      assert.ok(n.parameters.options.queryReplacement.startsWith('={{ ['));
      assert.ok(!n.parameters.query.includes('{{')); // all data uses query parameters
    }
  }
  assert.equal(node('HTTP - Strata Metrics').parameters.options.response.response.responseFormat, 'text');
});

async function databaseTests() {
  if (!process.env.STRATA_TEST_MYSQL) return;
  const database = `strata_tracker_test_${process.pid}_${Date.now()}`;
  const args = ['--no-defaults', '--batch', '--skip-column-names', '-uroot'];
  if (process.env.STRATA_TEST_SOCKET) args.push('--socket=' + process.env.STRATA_TEST_SOCKET);
  function sql(query, useDatabase = true, allowFailure = false) {
    const r = spawnSync(process.env.STRATA_TEST_MYSQL, [...args, ...(useDatabase ? [database] : [])], { input: query, encoding: 'utf8' });
    if (!allowFailure && r.status !== 0) throw new Error(r.stderr || String(r.error));
    return r;
  }
  const query = q => sql(q).stdout.trim();
  const acquire = (instance = 'strata-p40') => query(`CALL strata_tracker_acquire('${instance}', @a, @o); SELECT @a, @o;`).split('\t');
  const insert = (owner, prev, input = 100, output = 20, di = 0, dout = 0, instance = 'strata-p40', date = '2026-10-21 23:58:00.000') =>
    `CALL strata_tracker_insert('${instance}', '${owner}', '${date}', 1790000000, ${input}, ${output}, ${di}, ${dout}, ${prev});`;
  sql(`CREATE DATABASE ${database};`, false);
  try {
    sql(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    test('SQL schema and routines install', () => assert.equal(query('SELECT COUNT(*) FROM strata_token_usage;'), '0'));
    let [a, owner] = acquire();
    test('SQL competing lease is skipped', () => { assert.equal(a, '1'); assert.equal(acquire()[0], '0'); });
    query(insert(owner, 0));
    test('SQL baseline inserted and lease released atomically', () => {
      assert.equal(query('SELECT total_delta FROM strata_token_usage;'), '0');
      assert.equal(query('SELECT lease_owner IS NULL FROM strata_tracker_leases;'), '1');
    });
    owner = acquire()[1]; query(insert(owner, 1, 110, 25, 10, 5));
    test('SQL positive delta and generated total', () => assert.equal(query('SELECT SUM(total_delta) FROM strata_token_usage;'), '15'));
    test('SQL duplicate insert fails', () => assert.notEqual(sql(insert(owner, 1, 110, 25, 10, 5), true, true).status, 0));
    owner = acquire()[1];
    test('SQL stale baseline rejected', () => assert.notEqual(sql(insert(owner, 1), true, true).status, 0));
    query("UPDATE strata_tracker_leases SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND;");
    const stale = owner; owner = acquire()[1];
    test('SQL expired owner fenced out after reacquisition', () => {
      assert.notEqual(owner, stale); assert.notEqual(sql(insert(stale, 2), true, true).status, 0);
      assert.equal(query('SELECT COUNT(*) FROM strata_token_usage;'), '2');
    });
    query(insert(owner, 2, 110, 25, 0, 0));
    test('SQL zero usage cycle inserts', () => assert.equal(query('SELECT COUNT(*) FROM strata_token_usage;'), '3'));
    owner = acquire()[1];
    test('SQL insertion failure rolls back and keeps lease', () => {
      const invalid = insert(owner, 3).replace("'2026-10-21 23:58:00.000'", 'NULL');
      assert.notEqual(sql(invalid, true, true).status, 0);
      assert.equal(query('SELECT COUNT(*) FROM strata_token_usage;'), '3');
      assert.equal(acquire()[0], '0');
    });
    query("UPDATE strata_tracker_leases SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND;");
    owner = acquire()[1]; query(insert(owner, 3, 120, 30, 10, 5, 'strata-p40', '2026-10-22 00:02:00.000'));
    const midnightId = query("SELECT MAX(id) FROM strata_token_usage WHERE instance_id = 'strata-p40';");
    test('SQL midnight usage belongs to previous snapshot date', () => {
      assert.equal(query(`SELECT recorded_at, usage_date FROM strata_token_usage WHERE id = ${midnightId};`), '2026-10-22 00:02:00.000\t2026-10-21');
      assert.equal(query("SELECT SUM(total_delta) FROM strata_token_usage WHERE usage_date = '2026-10-21';"), '30');
      assert.equal(query("SELECT COUNT(*) FROM strata_token_usage WHERE usage_date = '2026-10-22';"), '0');
    });
    owner = acquire()[1]; query(insert(owner, midnightId, 130, 35, 10, 5, 'strata-p40', '2026-10-22 00:07:00.000'));
    test('SQL next interval uses current day', () => {
      assert.equal(query("SELECT usage_date FROM strata_token_usage WHERE instance_id = 'strata-p40' ORDER BY id DESC LIMIT 1;"), '2026-10-22');
    });
    owner = acquire('other-instance')[1];
    query(insert(owner, 0, 0, 0, 0, 0, 'other-instance', '2026-10-23 00:02:00.000'));
    test('SQL first snapshot uses own date independently per instance', () => {
      assert.equal(query("SELECT usage_date FROM strata_token_usage WHERE instance_id = 'other-instance';"), '2026-10-23');
    });
    const datesBeforeMigration = query('SELECT id, usage_date FROM strata_token_usage ORDER BY id;');
    query('ALTER TABLE strata_token_usage DROP INDEX idx_instance_usage_date, DROP COLUMN usage_date;');
    sql(fs.readFileSync(path.join(__dirname, 'migrations/001_usage_date.sql'), 'utf8'));
    sql(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    test('SQL migration backfills historical dates per instance and preserves totals', () => {
      assert.equal(query('SELECT id, usage_date FROM strata_token_usage ORDER BY id;'), datesBeforeMigration);
      assert.equal(query('SELECT SUM(total_delta) FROM strata_token_usage;'), '45');
    });
    const parallelAcquire = () => new Promise((resolve, reject) => {
      const p = spawn(process.env.STRATA_TEST_MYSQL, [...args, database]); let result = '', error = '';
      p.stdout.on('data', b => result += b); p.stderr.on('data', b => error += b);
      p.on('error', reject); p.on('close', code => code ? reject(new Error(error)) : resolve(result.trim().split('\t')));
      p.stdin.end("CALL strata_tracker_acquire('simultaneous', @a, @o); SELECT @a, @o;");
    });
    const results = await Promise.all(Array.from({ length: 8 }, parallelAcquire));
    test('SQL eight simultaneous executions have one owner', () => assert.equal(results.filter(r => r[0] === '1').length, 1));
    // Force a real row-lock timeout, separate from an active logical lease.
    const locker = spawn(process.env.STRATA_TEST_MYSQL, [...args, '--unbuffered', database]);
    const locked = new Promise((resolve, reject) => {
      locker.on('error', reject);
      locker.stdout.once('data', resolve);
      locker.on('exit', code => { if (code) reject(new Error('Lock-holder connection failed')); });
    });
    locker.stdin.write("START TRANSACTION; SELECT instance_id FROM strata_tracker_leases WHERE instance_id='simultaneous' FOR UPDATE;\n");
    await locked;
    try {
      const result = query("SET SESSION innodb_lock_wait_timeout=1; CALL strata_tracker_acquire('simultaneous', @a, @o); SELECT @a;");
      test('SQL physical row-lock timeout skips cycle', () => assert.equal(result, '0'));
    } finally {
      const done = new Promise(resolve => locker.on('close', resolve));
      locker.stdin.end('ROLLBACK;\n');
      await done;
    }
    owner = results.find(r => r[0] === '1')[1];
    query(insert(owner, 0, '18446744073709551615', 0, 0, 0, 'simultaneous'));
    test('SQL unsigned BIGINT stored exactly', () => assert.equal(query("SELECT input_total FROM strata_token_usage WHERE instance_id='simultaneous';"), '18446744073709551615'));
    const r = spawnSync(process.env.STRATA_TEST_MYSQL, ['--no-defaults', '--protocol=TCP', '-h127.0.0.1', '-P1', '--connect-timeout=1', '-uroot', '-e', 'SELECT 1'], { encoding: 'utf8' });
    test('unavailable MySQL fails connection', () => assert.notEqual(r.status, 0));
  } finally { sql(`DROP DATABASE ${database};`, false); }
}
databaseTests().then(() => console.log(`${passed} checks passed`)).catch(e => { console.error(e); process.exitCode = 1; });
