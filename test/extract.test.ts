import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, extractDocument, pickCandidateLinks } from '../src/extract.js';
import { SITE_PAGES } from './helpers.js';

describe('extractDocument', () => {
  const doc = extractDocument(SITE_PAGES['/']!);

  it('reads title, description and site name', () => {
    assert.equal(doc.title, 'Northwind Robotics | Autonomous forklifts for mid-size warehouses');
    assert.equal(doc.description, 'Northwind builds autonomy kits that retrofit onto existing forklift fleets.');
    assert.equal(doc.siteName, 'Northwind Robotics');
  });

  it('drops scripts, styles, navigation and footer', () => {
    assert.doesNotMatch(doc.text, /tracking|color:red|Log in|Terms|2026 Northwind/);
  });

  it('keeps content with light structure and decoded entities', () => {
    assert.match(doc.text, /^# Autonomous forklifts for mid-size warehouses$/m);
    assert.match(doc.text, /^# We’re hiring$/m);
    assert.match(doc.text, /Trusted by Harbor Foods and Kestrel Logistics across 37 sites\./);
    assert.match(doc.text, /^- Works with Toyota and Crown forklifts$/m);
  });

  it('de-duplicates repeated short lines', () => {
    assert.equal(doc.text.match(/Works with Toyota/g)?.length, 1);
  });

  it('collects links, including ones inside nav for discovery', () => {
    const hrefs = doc.links.map((l) => l.href);
    assert.ok(hrefs.includes('/about'));
    assert.ok(hrefs.includes('/pricing'));
  });

  it('removes the space tag-stripping leaves before punctuation', () => {
    const tidy = extractDocument('<p><b>Acme</b>\'s platform, <i>fast</i> .</p>');
    assert.equal(tidy.text, "Acme's platform, fast.");
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    assert.equal(decodeEntities('Fish &amp; chips &#8212; &#x2014; &rsquo;'), 'Fish & chips — — ’');
  });
  it('leaves unknown entities and rejects invalid code points', () => {
    assert.equal(decodeEntities('&bogus; &#xD800;'), '&bogus;  ');
  });
});

describe('pickCandidateLinks', () => {
  const base = new URL('https://www.northwind.example/');
  const links = [
    { href: '/about', text: 'About' },
    { href: '/pricing', text: 'Pricing' },
    { href: 'https://northwind.example/customers', text: 'Customer stories' },
    { href: '/blog/post-1', text: 'Blog' },
    { href: '/login', text: 'Log in' },
    { href: '/privacy', text: 'Privacy' },
    { href: 'https://twitter.com/northwind', text: 'About us on Twitter' },
    { href: 'mailto:hi@northwind.example', text: 'Email' },
    { href: '/brochure.pdf', text: 'About (PDF)' },
    { href: '/about#team', text: 'Team' },
  ];

  it('prefers about, pricing and customers pages on the same site', () => {
    const picked = pickCandidateLinks(links, base, 3);
    assert.deepEqual(picked, [
      'https://www.northwind.example/about',
      'https://www.northwind.example/pricing',
      'https://northwind.example/customers',
    ]);
  });

  it('never picks login, legal, external, mail or file links', () => {
    const picked = pickCandidateLinks(links, base, 10).join(' ');
    assert.doesNotMatch(picked, /login|privacy|twitter|mailto|\.pdf/);
  });

  it('respects the maximum', () => {
    assert.equal(pickCandidateLinks(links, base, 1).length, 1);
    assert.equal(pickCandidateLinks(links, base, 0).length, 0);
  });
});
