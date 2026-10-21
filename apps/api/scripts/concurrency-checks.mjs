// Concurrency checks for deposits, transfers and idempotency.
//
// Run from apps/api, with the API and the Postgres container running, and the
// API started with THROTTLE_LIMIT=100000 (this script sends several hundred
// requests in a minute):
//
//   node scripts/concurrency-checks.mjs
//
// PowerShell, to change the size of the storms:
//   $env:PARALLEL="30"; $env:SENDERS="12"; node scripts/concurrency-checks.mjs
//
// It creates its own users (conc-...@example.com) and leaves them in the
// database. Every check on balances uses fresh users, so reruns are safe.
// The invariant queries at the end cover the WHOLE database.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const ORIGIN = process.env.APP_URL ?? 'http://localhost:3000';

// Parallel requests per storm. It must be above 10: the overdraft test relies
// on ten transfers of 1000 emptying a wallet of 10000.
const PARALLEL = Math.max(12, Number(process.env.PARALLEL ?? 20));
const SENDERS = Math.max(2, Number(process.env.SENDERS ?? 8));

const COMPOSE_FILE =
  process.env.COMPOSE_FILE ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../docker-compose.yml',
  );
const DB_SERVICE = process.env.DB_SERVICE ?? 'postgres';
const DB_USER = process.env.DB_USER ?? 'ledger';
const DB_NAME = process.env.DB_NAME ?? 'ledger';

let passed = 0;
let failed = 0;

function check(name, ok, details = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${details ? `  ->  ${details}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Database, through docker compose
// ---------------------------------------------------------------------------

function psql(sql) {
  try {
    return execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        DB_SERVICE,
        'psql',
        '-U',
        DB_USER,
        '-d',
        DB_NAME,
        '-t', // rows only
        '-A', // no alignment padding
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        sql,
      ],
      { encoding: 'utf8' },
    ).trim();
  } catch (error) {
    throw new Error(
      `Could not run SQL through docker compose (${COMPOSE_FILE}). ` +
        `Is the "${DB_SERVICE}" container running?\n${error.message}`,
    );
  }
}

const countOf = (sql) => Number(psql(sql));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function request(user, method, pathname, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(user ? { cookie: user.cookie } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    throw new Error(
      'Rate limited (429). Start the API with THROTTLE_LIMIT=100000 in apps/api/.env and run again.',
    );
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // No body (for example a 204): nothing to read.
  }

  return {
    status: res.status,
    body: json,
    replayed: res.headers.get('idempotent-replayed') === 'true',
  };
}

async function signUp(label) {
  const email = `conc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  const res = await fetch(`${BASE}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      name: `Conc ${label}`,
      email,
      password: 'a-long-test-password-123',
    }),
  });

  if (res.status !== 201) {
    throw new Error(`Sign-up failed (${res.status}): ${await res.text()}`);
  }

  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  if (!cookie) throw new Error('Sign-up returned no session cookie');

  return { label, email, cookie };
}

/**
 * Signs the users up (one at a time: password hashing is memory-hungry),
 * marks their emails as verified directly in the database, and gives each
 * one a USD wallet.
 */
async function prepare(labels) {
  const users = [];
  for (const label of labels) users.push(await signUp(label));

  psql(
    `UPDATE "User" SET "emailVerified" = true WHERE email IN (${users
      .map((u) => `'${u.email}'`)
      .join(', ')})`,
  );

  for (const user of users) {
    const res = await request(user, 'POST', '/wallets', { currency: 'USD' });
    if (res.status !== 201) {
      throw new Error(
        `Creating the wallet of ${user.label} failed (${res.status}): ${JSON.stringify(res.body)}`,
      );
    }
    user.walletId = res.body.id;
  }

  return users;
}

const deposit = (user, amount, key = randomUUID()) =>
  request(
    user,
    'POST',
    '/transactions/deposits',
    { walletId: user.walletId, amount: String(amount) },
    { 'idempotency-key': key },
  );

const transfer = (user, to, amount, key = randomUUID()) =>
  request(
    user,
    'POST',
    '/transactions/transfers',
    {
      sourceWalletId: user.walletId,
      destinationWalletId: to.walletId,
      amount: String(amount),
    },
    { 'idempotency-key': key },
  );

async function fund(user, amount) {
  const res = await deposit(user, amount);
  if (res.status !== 201) {
    throw new Error(
      `Funding ${user.label} failed (${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
}

async function balanceOf(user) {
  const res = await request(user, 'GET', '/wallets');
  const wallet = Array.isArray(res.body)
    ? res.body.find((w) => w.id === user.walletId)
    : undefined;

  if (!wallet) {
    throw new Error(
      `Could not read the wallet of ${user.label} (status ${res.status})`,
    );
  }

  return BigInt(wallet.balance);
}

// ---------------------------------------------------------------------------
// Small helpers for reading results
// ---------------------------------------------------------------------------

const countStatus = (results, status) =>
  results.filter((r) => r.status === status).length;

const noServerErrors = (results) => results.every((r) => r.status < 500);

const show = (results) => {
  const tally = {};
  for (const { status } of results) tally[status] = (tally[status] ?? 0) + 1;
  return Object.entries(tally)
    .map(([status, n]) => `${status} x${n}`)
    .join(', ');
};

const allIdentical = (results) =>
  new Set(results.map((r) => JSON.stringify(r.body))).size === 1;

const compareBigInt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function overdraftStorm() {
  console.log(
    `\n1. Overdraft storm: ${PARALLEL} parallel transfers of 1000 from a wallet holding 10000`,
  );
  const [alice, bob] = await prepare(['alice', 'bob']);
  await fund(alice, 10000n);

  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () => transfer(alice, bob, 1000n)),
  );

  const expectedOk = 10;
  const expectedRefused = PARALLEL - expectedOk;

  check(
    `exactly ${expectedOk} succeed (201)`,
    countStatus(results, 201) === expectedOk,
    show(results),
  );
  check(
    `the other ${expectedRefused} are refused with 422`,
    countStatus(results, 422) === expectedRefused,
    show(results),
  );
  check(
    'every refusal is INSUFFICIENT_FUNDS',
    results
      .filter((r) => r.status === 422)
      .every((r) => r.body?.code === 'INSUFFICIENT_FUNDS'),
  );
  check('no request failed with a 5xx', noServerErrors(results), show(results));
  check('the sender ends at exactly 0', (await balanceOf(alice)) === 0n);
  check('the recipient got exactly 10000', (await balanceOf(bob)) === 10000n);

  const failedRows = countOf(
    `SELECT count(*) FROM "Transaction" t JOIN "User" u ON u.id = t."initiatedById" ` +
      `WHERE u.email = '${alice.email}' AND t.status = 'FAILED' AND t."failureReason" = 'INSUFFICIENT_FUNDS'`,
  );
  check(
    `${expectedRefused} FAILED transfers were recorded`,
    failedRows === expectedRefused,
    `found ${failedRows}`,
  );
}

async function oppositeDirections() {
  console.log(
    `\n2. Opposite directions: ${PARALLEL} transfers each way at the same time`,
  );
  const [carol, dave] = await prepare(['carol', 'dave']);
  await fund(carol, 100000n);
  await fund(dave, 100000n);

  // Interleaved, so both directions are in flight together.
  const requests = [];
  for (let i = 0; i < PARALLEL; i++) {
    requests.push(transfer(carol, dave, 100n));
    requests.push(transfer(dave, carol, 100n));
  }
  const results = await Promise.all(requests);

  check(
    `all ${PARALLEL * 2} succeed (201)`,
    countStatus(results, 201) === PARALLEL * 2,
    show(results),
  );
  check(
    'no deadlock: no request failed with a 5xx',
    noServerErrors(results),
    show(results),
  );
  check(
    'both balances are unchanged (100000)',
    (await balanceOf(carol)) === 100000n && (await balanceOf(dave)) === 100000n,
  );
}

async function sameKeyTransfers() {
  console.log(
    `\n3. Same key: ${PARALLEL} identical transfers sent at the same time`,
  );
  const [erin, frank] = await prepare(['erin', 'frank']);
  await fund(erin, 10000n);

  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () => transfer(erin, frank, 1000n, key)),
  );

  check(
    `all ${PARALLEL} answer 201`,
    countStatus(results, 201) === PARALLEL,
    show(results),
  );
  check(
    'exactly one is the original (no replay header)',
    results.filter((r) => !r.replayed).length === 1,
  );
  check(
    `the other ${PARALLEL - 1} are marked as replays`,
    results.filter((r) => r.replayed).length === PARALLEL - 1,
  );
  check('every answer is identical', allIdentical(results));
  check('the sender paid 1000 once (9000 left)', (await balanceOf(erin)) === 9000n);
  check('the recipient got 1000 once', (await balanceOf(frank)) === 1000n);
  check(
    'exactly one transaction row exists for the key',
    countOf(`SELECT count(*) FROM "Transaction" WHERE "idempotencyKey" = '${key}'`) === 1,
  );
}

async function sameKeyDeposits() {
  console.log(
    `\n4. Same key: ${PARALLEL} identical deposits sent at the same time`,
  );
  const [grace] = await prepare(['grace']);

  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () => deposit(grace, 500n, key)),
  );

  check(
    `all ${PARALLEL} answer 201`,
    countStatus(results, 201) === PARALLEL,
    show(results),
  );
  check(
    'exactly one is the original (no replay header)',
    results.filter((r) => !r.replayed).length === 1,
  );
  check('every answer is identical', allIdentical(results));
  check('the wallet was credited once (500)', (await balanceOf(grace)) === 500n);
  check(
    'exactly one transaction row exists for the key',
    countOf(`SELECT count(*) FROM "Transaction" WHERE "idempotencyKey" = '${key}'`) === 1,
  );
}

async function sameKeyDifferentBodies() {
  console.log('\n5. Same key, 10 different amounts at the same time');
  const [heidi, ivan] = await prepare(['heidi', 'ivan']);
  await fund(heidi, 100000n);

  const key = randomUUID();
  const amounts = Array.from({ length: 10 }, (_, i) => BigInt((i + 1) * 100));
  const results = await Promise.all(
    amounts.map((amount) => transfer(heidi, ivan, amount, key)),
  );

  const winners = results.filter((r) => r.status === 201);

  check('exactly one request succeeds', winners.length === 1, show(results));
  check(
    'the other nine are 422 IDEMPOTENCY_KEY_REUSED',
    results
      .filter((r) => r.status === 422)
      .every((r) => r.body?.code === 'IDEMPOTENCY_KEY_REUSED') &&
      countStatus(results, 422) === 9,
    show(results),
  );
  check('no request failed with a 5xx', noServerErrors(results), show(results));

  if (winners.length === 1) {
    const winnerAmount = BigInt(winners[0].body.amount);
    check(
      "only the winner's amount moved",
      (await balanceOf(heidi)) === 100000n - winnerAmount &&
        (await balanceOf(ivan)) === winnerAmount,
      `winner amount ${winnerAmount}`,
    );
  }

  check(
    'exactly one transaction row exists for the key',
    countOf(`SELECT count(*) FROM "Transaction" WHERE "idempotencyKey" = '${key}'`) === 1,
  );
}

async function depositStorm() {
  console.log(
    `\n6. Deposit storm: ${PARALLEL} parallel deposits of 100, different keys`,
  );
  const [judy] = await prepare(['judy']);

  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () => deposit(judy, 100n)),
  );

  check(
    `all ${PARALLEL} succeed (201)`,
    countStatus(results, 201) === PARALLEL,
    show(results),
  );
  check(
    `the wallet holds exactly ${PARALLEL * 100}`,
    (await balanceOf(judy)) === BigInt(PARALLEL * 100),
  );

  // The deposits are serialized by the lock on the funding wallet, so each
  // one must have seen a different balance: 100, 200, 300... with no gaps
  // and no repeats. A repeat or a gap would be a lost update.
  const seen = results
    .filter((r) => r.status === 201)
    .map((r) => BigInt(r.body.balanceAfter))
    .sort(compareBigInt)
    .join(',');
  const expected = Array.from({ length: PARALLEL }, (_, i) =>
    BigInt((i + 1) * 100),
  ).join(',');

  check('the balances returned are 100, 200, 300... with no gaps', seen === expected, seen);
}

async function fanIn() {
  console.log(
    `\n7. Fan-in: ${SENDERS} different senders send 1000 each to one recipient at once`,
  );
  const labels = ['receiver', ...Array.from({ length: SENDERS }, (_, i) => `sender${i + 1}`)];
  const [receiver, ...senders] = await prepare(labels);
  await Promise.all(senders.map((sender) => fund(sender, 5000n)));

  const results = await Promise.all(
    senders.map((sender) => transfer(sender, receiver, 1000n)),
  );

  check(
    `all ${SENDERS} succeed (201)`,
    countStatus(results, 201) === SENDERS,
    show(results),
  );
  check(
    `the recipient holds exactly ${SENDERS * 1000}`,
    (await balanceOf(receiver)) === BigInt(SENDERS * 1000),
  );

  const balances = await Promise.all(senders.map((s) => balanceOf(s)));
  check('every sender has 4000 left', balances.every((b) => b === 4000n));
}

// ---------------------------------------------------------------------------
// The books, after everything
// ---------------------------------------------------------------------------

function invariants() {
  console.log('\nInvariants over the whole database');

  const queries = [
    [
      'every wallet balance equals the sum of its ledger entries',
      `SELECT count(*) FROM (
         SELECT w.id FROM "Wallet" w
         LEFT JOIN "LedgerEntry" e ON e."walletId" = w.id
         GROUP BY w.id, w.balance
         HAVING w.balance <> COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
       ) bad`,
    ],
    [
      'every transaction has equal debits and credits',
      `SELECT count(*) FROM (
         SELECT "transactionId" FROM "LedgerEntry"
         GROUP BY "transactionId"
         HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END)
             <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
       ) bad`,
    ],
    [
      'all the money in the system adds up to zero',
      `SELECT COALESCE(SUM(balance), 0) FROM "Wallet"`,
    ],
    [
      'no user wallet is negative',
      `SELECT count(*) FROM "Wallet" WHERE "isSystem" = false AND balance < 0`,
    ],
    [
      'no user has two transactions with the same key',
      `SELECT count(*) FROM (
         SELECT 1 FROM "Transaction" GROUP BY "initiatedById", "idempotencyKey" HAVING count(*) > 1
       ) bad`,
    ],
    [
      'FAILED transactions have no ledger entries',
      `SELECT count(*) FROM "LedgerEntry" e
       JOIN "Transaction" t ON t.id = e."transactionId" WHERE t.status = 'FAILED'`,
    ],
    [
      'no transaction is left PENDING',
      `SELECT count(*) FROM "Transaction" WHERE status = 'PENDING'`,
    ],
  ];

  for (const [name, sql] of queries) {
    const value = psql(sql);
    check(name, value === '0', `got ${value}, expected 0`);
  }
}

async function main() {
  console.log(`API: ${BASE}`);
  console.log(`Parallel requests per storm: ${PARALLEL}, fan-in senders: ${SENDERS}`);

  psql('SELECT 1'); // fail early if the database is not reachable

  await overdraftStorm();
  await oppositeDirections();
  await sameKeyTransfers();
  await sameKeyDeposits();
  await sameKeyDifferentBodies();
  await depositStorm();
  await fanIn();
  invariants();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});