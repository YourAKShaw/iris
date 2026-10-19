import { BlockList, isIP, type LookupFunction } from 'node:net';
import { promises as dns, type LookupAddress } from 'node:dns';
import { IrisError } from './errors.js';

/**
 * SSRF protection for user-supplied URLs.
 *
 * The decisive check happens in `createGuardedLookup`, which runs when the socket connects.
 * Validating the resolved address there (not only before the request) closes the
 * DNS-rebinding gap between "check" and "use". Every redirect hop goes through it again.
 */

// Separate lists on purpose: a single BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so `::ffff:0:0/96` would block every public IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped (fail closed rather than unpack)
  ['64:ff9b::', 96], // NAT64 can reach internal IPv4
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 embeds IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

for (const [network, prefix] of BLOCKED_V4) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_V6) blockedV6.addSubnet(network, prefix, 'ipv6');

/** True when the address is not a public unicast address. Non-IP input fails closed. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, 'ipv4');
  if (family === 6) return blockedV6.check(address, 'ipv6');
  return true;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

export interface UrlPolicy {
  allowPrivateHosts: boolean;
}

/** Fast pre-flight checks on a URL. The connect-time DNS check is still authoritative. */
export function assertFetchableUrl(url: URL, policy: UrlPolicy): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IrisError('URL_BLOCKED', 'Only http:// and https:// websites are supported.');
  }
  if (url.username || url.password) {
    throw new IrisError('URL_BLOCKED', 'URLs that contain credentials are not allowed.');
  }
  if (policy.allowPrivateHosts) return;

  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new IrisError('URL_BLOCKED', 'Only standard web ports (80 and 443) are allowed.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new IrisError('URL_BLOCKED', 'That address is on a private or reserved network.');
    }
    return;
  }
  if (
    host === 'localhost' ||
    !host.includes('.') ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new IrisError('URL_BLOCKED', 'That host is not a public website.');
  }
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * A `lookup` implementation for http(s).request that refuses to connect when any resolved
 * address is private or reserved. Supports both the single-address and `all: true` forms
 * Node uses (the latter when happy-eyeballs `autoSelectFamily` is on).
 */
export function createGuardedLookup(policy: UrlPolicy, resolver: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        const wanted = options.family === 4 || options.family === 6 ? options.family : undefined;
        const candidates = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
        if (candidates.length === 0) {
          const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          error.code = 'ENOTFOUND';
          callback(error, '', 0);
          return;
        }
        if (!policy.allowPrivateHosts && candidates.some((a) => isBlockedAddress(a.address))) {
          callback(
            new IrisError('URL_BLOCKED', 'That website resolves to a private or reserved network address.'),
            '',
            0,
          );
          return;
        }
        const first = candidates[0]!;
        if (options.all) callback(null, candidates);
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  };
}
