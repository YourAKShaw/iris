import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResearchDraftSchema, normalizeForMatch, quoteAppearsIn, verifyResearch } from '../src/research.js';
import { IrisError } from '../src/errors.js';
import type { SourcePage } from '../src/site.js';
import { researchReply } from './helpers.js';

const ORIGIN = 'https://northwind.example';

const pages: SourcePage[] = [
  {
    url: `${ORIGIN}/`,
    title: 'Northwind Robotics',
    description: '',
    text: [
      '# Autonomous forklifts for mid-size warehouses',
      'Northwind retrofits your existing forklifts with autonomy kits in under 48 hours.',
      'Trusted by Harbor Foods and Kestrel Logistics across 37 sites.',
      '# We’re hiring',
      'We are hiring 12 field engineers in Texas and Ohio this quarter.',
    ].join('\n'),
  },
  { url: `${ORIGIN}/about`, title: 'About', description: '', text: 'Founded in 2021 by former Amazon Robotics engineers, Northwind is based in Columbus, Ohio.' },
  { url: `${ORIGIN}/pricing`, title: 'Pricing', description: '', text: 'Pricing starts at $1,200 per forklift per month, with no upfront hardware cost.' },
];

describe('quote matching', () => {
  const page = normalizeForMatch(pages[0]!.text);

  it('matches regardless of curly quotes, case and whitespace', () => {
    assert.equal(quoteAppearsIn('“We\'re   HIRING”', normalizeForMatch('# We’re hiring now and then some')), false); // too short
    assert.equal(quoteAppearsIn('we are hiring 12 FIELD engineers in   Texas', page), true);
  });

  it('ignores the structure markers the extractor adds', () => {
    assert.equal(quoteAppearsIn('Autonomous forklifts for mid-size warehouses', page), true);
  });

  it('accepts ellipses only when every fragment appears in order', () => {
    assert.equal(quoteAppearsIn('Northwind retrofits your existing forklifts … across 37 sites', page), true);
    assert.equal(quoteAppearsIn('across 37 sites … Northwind retrofits your existing forklifts', page), false);
  });

  it('rejects paraphrases and very short quotes', () => {
    assert.equal(quoteAppearsIn('Northwind upgrades forklifts within two days', page), false);
    assert.equal(quoteAppearsIn('Northwind', page), false);
  });
});

describe('verifyResearch', () => {
  const draft = ResearchDraftSchema.parse(researchReply(ORIGIN));
  const brief = verifyResearch(draft, pages);

  it('keeps only signals whose quotes are on a fetched page', () => {
    assert.equal(brief.proposedSignals, 6);
    assert.equal(brief.signals.length, 5);
    assert.equal(brief.dropped.length, 1);
    assert.match(brief.dropped[0]!.claim, /Series B/);
  });

  it('renumbers verified signals contiguously', () => {
    assert.deepEqual(
      brief.signals.map((s) => s.id),
      ['s1', 's2', 's3', 's4', 's5'],
    );
  });

  it('corrects a mis-cited source page when the quote exists elsewhere', () => {
    const hiring = brief.signals.find((s) => s.category === 'hiring');
    assert.equal(hiring?.sourceUrl, `${ORIGIN}/`);
  });

  it('remaps hypothesis references and drops ones built on unverified claims', () => {
    assert.equal(brief.hypotheses.length, 2);
    assert.deepEqual(brief.hypotheses[0]!.basedOn, ['s3', 's1']);
    // Original s5 (pricing) became s4 after the invented s4 was dropped.
    assert.deepEqual(brief.hypotheses[1]!.basedOn, ['s4']);
    assert.ok(!brief.hypotheses.some((h) => /funding/i.test(h.statement)));
  });

  it('refuses to continue when nothing can be verified', () => {
    const invented = ResearchDraftSchema.parse({
      company: { name: 'X', oneLiner: 'Y' },
      signals: [{ id: 's1', category: 'other', claim: 'Made up', quote: 'This sentence does not appear anywhere on the site.', sourceUrl: '' }],
    });
    assert.throws(() => verifyResearch(invented, pages), (error: unknown) => error instanceof IrisError && error.code === 'INSUFFICIENT_EVIDENCE');
  });

  it('drops duplicate quotes', () => {
    const duplicate = ResearchDraftSchema.parse({
      company: { name: 'X', oneLiner: 'Y' },
      signals: [
        { id: 'a', category: 'pricing', claim: 'one', quote: 'Pricing starts at $1,200 per forklift per month', sourceUrl: '' },
        { id: 'b', category: 'pricing', claim: 'two', quote: 'pricing starts at $1,200 per forklift per month', sourceUrl: '' },
      ],
    });
    const result = verifyResearch(duplicate, pages);
    assert.equal(result.signals.length, 1);
    assert.equal(result.dropped[0]?.reason, 'duplicate quote');
  });
});

describe('ResearchDraftSchema', () => {
  it('coerces numeric ids, unknown categories and clips long text', () => {
    const parsed = ResearchDraftSchema.parse({
      company: { name: 'Acme', oneLiner: 'x'.repeat(500) },
      signals: [{ id: 1, category: 'gossip', claim: 'c', quote: 'q', sourceUrl: 'u' }],
    });
    assert.equal(parsed.signals[0]!.id, '1');
    assert.equal(parsed.signals[0]!.category, 'other');
    assert.equal(parsed.company.oneLiner.length, 280);
    assert.deepEqual(parsed.hypotheses, []);
  });

  it('rejects a draft without signals', () => {
    assert.equal(ResearchDraftSchema.safeParse({ company: { name: 'A', oneLiner: 'B' }, signals: [] }).success, false);
  });
});
