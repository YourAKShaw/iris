import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEmail, parseRecipient, wordCount } from '../src/outreach.js';

const ids = new Set(['s1', 's2']);
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const email = (overrides: Partial<{ angle: string; subject: string; body: string; basedOn: string[] }> = {}) => ({
  angle: 'Angle',
  subject: 'A specific subject line',
  body: words(80),
  basedOn: ['s1'],
  ...overrides,
});

describe('checkEmail', () => {
  it('accepts a grounded, well-formed draft', () => {
    assert.deepEqual(checkEmail(email(), ids, 0), []);
  });

  it('rejects links, including bare domains with paths', () => {
    for (const body of [`${words(60)} https://evil.example`, `${words(60)} www.evil.example`, `${words(60)} evil.com/claim`]) {
      assert.match(checkEmail(email({ body }), ids, 0).join(' '), /links or URLs/);
    }
  });

  it('allows a plain company domain without a path', () => {
    assert.deepEqual(checkEmail(email({ body: `${words(60)} at acme.com today` }), ids, 0), []);
  });

  it('rejects placeholders', () => {
    assert.match(checkEmail(email({ body: `Hi [First Name], ${words(60)}` }), ids, 0).join(' '), /placeholders/);
    assert.match(checkEmail(email({ body: `Hi {{name}}, ${words(60)}` }), ids, 0).join(' '), /placeholders/);
  });

  it('enforces length limits', () => {
    assert.match(checkEmail(email({ body: words(20) }), ids, 0).join(' '), /40–170 words/);
    assert.match(checkEmail(email({ body: words(400) }), ids, 0).join(' '), /40–170 words/);
    assert.match(checkEmail(email({ subject: 'x'.repeat(120) }), ids, 0).join(' '), /subject/);
  });

  it('requires at least one verified fact', () => {
    assert.match(checkEmail(email({ basedOn: [] }), ids, 0).join(' '), /basedOn/);
    assert.match(checkEmail(email({ basedOn: ['s9'] }), ids, 0).join(' '), /basedOn/);
  });
});

describe('parseRecipient', () => {
  it('splits name and role', () => {
    assert.deepEqual(parseRecipient('Priya Rao, Head of Growth'), { name: 'Priya Rao', role: 'Head of Growth', firstName: 'Priya' });
  });
  it('handles a name only', () => {
    assert.deepEqual(parseRecipient('Priya'), { name: 'Priya', role: undefined, firstName: 'Priya' });
  });
  it('handles nothing', () => {
    assert.deepEqual(parseRecipient('  '), { name: undefined, role: undefined, firstName: undefined });
  });
});

describe('wordCount', () => {
  it('counts across newlines', () => assert.equal(wordCount('Hi there,\n\nthree words here'), 5));
});
