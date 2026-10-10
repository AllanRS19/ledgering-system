// Run from apps/api with the API already running:
//   node scripts/stage2-checks.mjs
//
// PowerShell, to use other currencies for the races:
//   $env:RACE_CURRENCY="EUR"; $env:SAME_USER_RACE_CURRENCY="DOP"; node scripts/stage2-checks.mjs

const BASE = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const ORIGIN = process.env.APP_URL ?? 'http://localhost:3000';
// For the system-wallet race to mean something, nobody may have a wallet in
// this currency yet (see "Re-running" in the guide).
const RACE_CURRENCY = process.env.RACE_CURRENCY ?? 'GBP';
const SAME_USER_RACE_CURRENCY = process.env.SAME_USER_RACE_CURRENCY ?? 'AUD';

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

async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

async function signUp(label) {
    const email = `stage2-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const res = await fetch(`${BASE}/auth/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
            name: `Stage2 ${label}`,
            email,
            password: 'a-long-test-password-123',
        }),
    });

    if (res.status !== 201) {
        throw new Error(`Sign-up failed (${res.status}): ${await res.text()}`);
    }

    // Keep only "name=value" from each Set-Cookie header and send it back by hand.
    const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');

    if (!cookie) throw new Error('Sign-up returned no session cookie');

    return { email, cookie };
}

function call(user, method, path, body) {
    return fetch(`${BASE}${path}`, {
        method,
        headers: {
            origin: ORIGIN,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(user ? { cookie: user.cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

async function main() {
    console.log(`API: ${BASE}\n`);

    const alice = await signUp('alice');
    const bob = await signUp('bob');

    console.log('Creating wallets');
    let res = await call(alice, 'POST', '/wallets', { currency: 'USD' });
    let body = await readJson(res);
    check('create a USD wallet -> 201', res.status === 201, `status ${res.status}`);
    check(
        'response has exactly id, currency, balance, createdAt',
        body !== null &&
        JSON.stringify(Object.keys(body).sort()) ===
        JSON.stringify(['balance', 'createdAt', 'currency', 'id']),
        JSON.stringify(body),
    );
    check('balance starts as the string "0"', body?.balance === '0', String(body?.balance));
    check('currency is USD', body?.currency === 'USD', String(body?.currency));
    const aliceUsdId = body?.id;

    res = await call(alice, 'POST', '/wallets', { currency: 'USD' });
    check('same user, same currency again -> 409', res.status === 409, `status ${res.status}`);

    res = await call(bob, 'POST', '/wallets', { currency: ' usd ' });
    body = await readJson(res);
    check(
        'another user, " usd " is normalized to USD -> 201',
        res.status === 201 && body?.currency === 'USD',
        `status ${res.status}, currency ${body?.currency}`,
    );
    const bobUsdId = body?.id;

    console.log('\nInvalid input (all must be 400, never 500)');
    const badPayloads = [
        ['unsupported currency "XYZ"', { currency: 'XYZ' }],
        ['empty body', {}],
        ['currency is a number', { currency: 5 }],
        ['currency is null', { currency: null }],
        ['empty string', { currency: '' }],
        ['"U-S-D" is not repaired into USD', { currency: 'U-S-D' }],
        ['extra field isSystem is rejected', { currency: 'EUR', isSystem: true }],
    ];
    for (const [label, payload] of badPayloads) {
        res = await call(alice, 'POST', '/wallets', payload);
        check(`${label} -> 400`, res.status === 400, `status ${res.status}`);
    }

    console.log('\nReading wallets');
    res = await call(alice, 'GET', '/wallets');
    body = await readJson(res);
    check('list -> 200', res.status === 200, `status ${res.status}`);
    check(
        "list contains only the caller's wallet",
        Array.isArray(body) && body.length === 1 && body[0].id === aliceUsdId,
        JSON.stringify(body),
    );
    check(
        'list items expose no userId / isSystem',
        Array.isArray(body) &&
        body.every((w) => !('userId' in w) && !('isSystem' in w)),
    );

    res = await call(alice, 'GET', `/wallets/${aliceUsdId}`);
    check('get own wallet -> 200', res.status === 200, `status ${res.status}`);

    res = await call(alice, 'GET', `/wallets/${bobUsdId}`);
    check("get someone else's wallet -> 404", res.status === 404, `status ${res.status}`);

    res = await call(alice, 'GET', `/wallets/${crypto.randomUUID()}`);
    check('get an unknown UUID -> 404', res.status === 404, `status ${res.status}`);

    res = await call(alice, 'GET', '/wallets/not-a-uuid');
    check('get a malformed id -> 400', res.status === 400, `status ${res.status}`);

    res = await call(null, 'GET', '/wallets');
    check('no session -> 401', res.status === 401, `status ${res.status}`);

    console.log(
        `\nRace: one user sends 5 parallel ${SAME_USER_RACE_CURRENCY} wallet requests`,
    );
    const carol = await signUp('carol');
    const sameUser = await Promise.all(
        Array.from({ length: 5 }, () =>
            call(carol, 'POST', '/wallets', { currency: SAME_USER_RACE_CURRENCY }),
        ),
    );
    const sameUserCodes = sameUser.map((r) => r.status);
    check(
        'exactly one 201',
        sameUserCodes.filter((s) => s === 201).length === 1,
        sameUserCodes.join(', '),
    );
    check(
        'the other four are 409',
        sameUserCodes.filter((s) => s === 409).length === 4,
        sameUserCodes.join(', '),
    );

    console.log(
        `\nRace: 8 different users create their first ${RACE_CURRENCY} wallet at once`,
    );
    // Signed up one at a time: password hashing is deliberately memory-hungry.
    const racers = [];
    for (let i = 0; i < 8; i++) racers.push(await signUp(`racer${i}`));

    const raceResults = await Promise.all(
        racers.map((u) => call(u, 'POST', '/wallets', { currency: RACE_CURRENCY })),
    );
    const raceCodes = raceResults.map((r) => r.status);
    check(
        'all 8 answer 201, none is a 500',
        raceCodes.every((s) => s === 201),
        raceCodes.join(', '),
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(
        'Now run the SQL checks from the guide: they verify the database side.',
    );
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});