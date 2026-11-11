import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutreachMessages, checkEmail, checkMix, factMix, formatEmailBody, formatSignature, personFactsUsed, mentionsFactIds, parseRecipient, stripFactIds, wordCount } from '../src/outreach.js';

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
  it('skips common honorifics with or without periods', () => {
    for (const title of ['Dr', 'Mr', 'Mrs', 'Ms', 'Prof']) {
      for (const suffix of ['', '.']) {
        assert.deepEqual(parseRecipient(`${title}${suffix} Jane Doe, Director`), {
          name: `${title}${suffix} Jane Doe`,
          role: 'Director',
          firstName: 'Jane',
        });
      }
    }
  });
  it('handles case-insensitive and consecutive honorifics', () => {
    assert.equal(parseRecipient('DR. PROF. Jane Doe').firstName, 'Jane');
    assert.equal(parseRecipient('ms jane doe').firstName, 'jane');
  });
  it('does not use an honorific alone as a first name', () => {
    assert.equal(parseRecipient('Dr.').firstName, undefined);
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

describe('fact ids in drafts', () => {
  const ten = new Set(['s1', 's2', 's10']);

  it('asks for a rewrite when the body or subject cites fact ids', () => {
    assert.match(checkEmail(email({ body: `${words(60)} (S1)` }), ids, 0).join(' '), /fact ids/);
    assert.match(checkEmail(email({ subject: 'Your launch, s2' }), ids, 0).join(' '), /fact ids/);
  });

  it('strips bracketed and bare ids and tidies the punctuation left behind', () => {
    assert.equal(stripFactIds('You shipped offline sync (S1), which is rare.', ten), 'You shipped offline sync, which is rare.');
    assert.equal(stripFactIds('Saw your hiring push [s2, S10].', ten), 'Saw your hiring push.');
    assert.equal(stripFactIds('Two things stood out (facts: s1 and s2).\nS10 too.', ten), 'Two things stood out.\ntoo.');
    assert.equal(stripFactIds('Hi Priya,\n\nYour S1 launch.', ten), 'Hi Priya,\n\nYour launch.');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Your Series B and 2 launches in Q1 (both in 2026) stood out.';
    assert.equal(mentionsFactIds(text, ten), false);
    assert.equal(stripFactIds(text, ten), text);
    assert.equal(stripFactIds('We shipped 1 thing (1).', new Set(['1'])), 'We shipped 1 thing.', 'numeric ids only go when bracketed');
  });
});

describe('formatEmailBody', () => {
  const sender = { name: 'Ayush', company: 'YourAKShaw' };

  it('splits the greeting, joins hard-wrapped lines and adds one sign-off', () => {
    const raw = 'Hi Priya, I saw you are hiring\nfield engineers.\nThat is a lot of scheduling.\n\nWorth a call?\n\nCheers,\nAyush\nYourAKShaw';
    assert.equal(
      formatEmailBody(raw, sender),
      'Hi Priya,\n\nI saw you are hiring field engineers. That is a lot of scheduling.\n\nWorth a call?\n\nBest,\nAyush\nYourAKShaw',
    );
  });

  it('signs with every sender detail in the set order, skipping empty ones', () => {
    const full = { name: 'Ayush', role: 'Founder', company: 'YourAKShaw', address: '1 Main St, Pune', mobile: '+91 90000 00000', email: 'a@example.com', website: 'example.com' };
    const signature = 'Ayush | Founder\nYourAKShaw\n1 Main St, Pune\nMobile: +91 90000 00000\na@example.com | example.com';
    assert.equal(formatSignature(full), signature);
    assert.equal(formatEmailBody(`Hi Priya,\n\nHello.\n\nBest,\n${signature}`, full), `Hi Priya,\n\nHello.\n\nBest,\n${signature}`);
    assert.equal(formatSignature({ name: 'Ayush', company: 'YourAKShaw', website: 'example.com' }), 'Ayush\nYourAKShaw\nexample.com');
  });

  it('leaves a well-formed body alone apart from the sign-off', () => {
    const raw = 'Hi Priya,\n\nFirst paragraph.\n\nSecond paragraph.';
    assert.equal(formatEmailBody(raw, sender), `${raw}\n\nBest,\nAyush\nYourAKShaw`);
  });
});

describe('company and person facts in every draft', () => {
  const sig = (id: string, category: string, sourceUrl: string, claim = '') => ({ id, category, claim, quote: '', sourceUrl }) as never;
  const company = sig('s1', 'product', 'https://linear.app/');
  const linkedin = sig('s2', 'person', 'https://www.linkedin.com/in/cristinajcordova', 'Cristina previously built the partner ecosystem at Notion and Stripe.');
  const x = sig('s3', 'person', 'https://x.com/cjc', 'Cristina posts about operating cadence at Linear.');
  const draft = (basedOn: string[], body: string) => ({ subject: 'Subject', body, basedOn });

  it('company only: each draft needs a company fact', () => {
    const mix = factMix({ signals: [company] });
    assert.deepEqual(checkMix(draft(['s1'], 'Plain company email.'), mix, 'e'), []);
    assert.match(checkMix(draft([], 'x'), mix, 'e').join(' '), /company fact/);
  });

  it('company plus a profile: the body must visibly use the profile, not just cite it', () => {
    const mix = factMix({ signals: [company, linkedin], company: { name: 'Linear' } }, 'Cristina Cordova');
    assert.deepEqual(checkMix(draft(['s1', 's2'], 'Having built partner programs at Notion, you know integrations.'), mix, 'e'), []);
    assert.match(checkMix(draft(['s1', 's2'], 'Linear ships fast. Cristina, worth a call?'), mix, 'e').join(' '), /specific detail.*notion/i);
    assert.match(checkMix(draft(['s2'], 'Your Stripe years show.'), mix, 'e').join(' '), /company fact/);
  });

  it('company plus both profiles: groups person facts by network', () => {
    const mix = factMix({ signals: [company, linkedin, x] });
    assert.deepEqual([...mix.profiles.keys()].sort(), ['LinkedIn', 'X']);
    assert.deepEqual(personFactsUsed(draft(['s1', 's2', 's3'], 'Your posts on operating cadence resonated.'), mix), ['s3']);
  });
});

describe('buildOutreachMessages', () => {
  it('sends only audited facts, never the unchecked company summary', () => {
    const brief = {
      company: { name: 'Acme', oneLiner: 'Serves enterprise teams worldwide.', offering: 'Unlimited integrations.', audience: 'Fortune 500.' },
      signals: [{ id: 's1', category: 'product' as const, claim: 'Ships weekly.', quote: 'We ship every week.', sourceUrl: 'u', sourceType: 'company_site' as const, retrievedAt: 't' }],
      hypotheses: [],
      dropped: [{ claim: 'Serves enterprise teams.', quote: "We don't serve enterprise teams.", reason: 'contradicted' }],
      proposedSignals: 2,
    };
    const sender = { name: 'S', role: '', company: 'Co', offer: 'help', address: '', mobile: '', email: '', website: '' };
    const user = buildOutreachMessages(brief, sender as never, parseRecipient(undefined))[1]!.content;
    assert.match(user, /Ships weekly/);
    for (const unchecked of ['enterprise', 'Unlimited', 'Fortune']) assert.ok(!user.includes(unchecked), unchecked);
  });
});
