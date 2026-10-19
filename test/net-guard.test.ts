import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { assertFetchableUrl, createGuardedLookup, isBlockedAddress } from '../src/net-guard.js';
import { IrisError } from '../src/errors.js';

const strict = { allowPrivateHosts: false };

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe80::1',
    'fd12:3456::1',
    '64:ff9b::a00:1',
    '2002:a00:1::1',
    'not-an-ip',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e'];

  for (const address of blocked) {
    it(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
  }
  // Regression: a shared BlockList made `::ffff:0:0/96` match every IPv4 address.
  for (const address of allowed) {
    it(`allows public ${address}`, () => assert.equal(isBlockedAddress(address), false));
  }
});

describe('assertFetchableUrl', () => {
  const rejects = (url: string) =>
    assert.throws(() => assertFetchableUrl(new URL(url), strict), (error: unknown) => error instanceof IrisError && error.code === 'URL_BLOCKED');

  it('rejects non-http schemes', () => rejects('file:///etc/passwd'));
  it('rejects ftp', () => rejects('ftp://example.com/'));
  it('rejects embedded credentials', () => rejects('https://user:pass@example.com/'));
  it('rejects non-standard ports', () => rejects('https://example.com:8443/'));
  it('rejects localhost names', () => rejects('http://localhost/'));
  it('rejects .internal names', () => rejects('http://metadata.google.internal/'));
  it('rejects single-label hosts', () => rejects('http://intranet/'));
  it('rejects loopback literals', () => rejects('http://127.0.0.1/'));
  it('rejects integer-encoded loopback (WHATWG normalises it)', () => rejects('http://2130706433/'));
  it('rejects IPv6 loopback literals', () => rejects('http://[::1]/'));
  it('rejects cloud metadata', () => rejects('http://169.254.169.254/latest/meta-data/'));
  it('accepts a public site', () => assert.doesNotThrow(() => assertFetchableUrl(new URL('https://example.com/about'), strict)));
  it('allows private hosts only when explicitly enabled', () =>
    assert.doesNotThrow(() => assertFetchableUrl(new URL('http://127.0.0.1:4000/'), { allowPrivateHosts: true })));
});

describe('createGuardedLookup', () => {
  const fakeResolver = (addresses: LookupAddress[]) => async () => addresses;

  function lookup(addresses: LookupAddress[], all: boolean, allowPrivateHosts = false) {
    const guarded = createGuardedLookup({ allowPrivateHosts }, fakeResolver(addresses));
    return new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family: unknown }>((resolve) => {
      guarded('example.com', { all }, (error, address, family) => resolve({ error, address, family }));
    });
  }

  it('refuses DNS answers that point at private space (rebinding defence)', async () => {
    const result = await lookup([{ address: '10.0.0.5', family: 4 }], false);
    assert.ok(result.error instanceof IrisError);
    assert.equal((result.error as IrisError).code, 'URL_BLOCKED');
  });

  it('refuses mixed answers if any address is private', async () => {
    const result = await lookup(
      [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      true,
    );
    assert.equal((result.error as IrisError).code, 'URL_BLOCKED');
  });

  it('returns the first public address in single mode', async () => {
    const result = await lookup([{ address: '93.184.216.34', family: 4 }], false);
    assert.equal(result.error, null);
    assert.equal(result.address, '93.184.216.34');
    assert.equal(result.family, 4);
  });

  it('returns every address when Node asks for all (happy eyeballs)', async () => {
    const answers = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    const result = await lookup(answers, true);
    assert.equal(result.error, null);
    assert.deepEqual(result.address, answers);
  });

  it('reports ENOTFOUND when nothing resolves', async () => {
    const result = await lookup([], false);
    assert.equal(result.error?.code, 'ENOTFOUND');
  });
});

describe('fetchHtml wiring', () => {
  it('applies the guarded lookup inside the real HTTP request (DNS rebinding to loopback)', async () => {
    const { fetchHtml } = await import('../src/site.js');
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig({ LLM_API_KEY: 'unused' });
    // Passes the pre-flight URL checks (public-looking name, port 80), then resolves to loopback.
    const rebinding = async () => [{ address: '127.0.0.1', family: 4 }];
    await assert.rejects(
      fetchHtml('http://rebind.example/', { ...config.fetch, resolver: rebinding }),
      (error: unknown) => error instanceof IrisError && error.code === 'URL_BLOCKED',
    );
  });
});
