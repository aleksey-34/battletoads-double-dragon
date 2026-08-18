import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAlgofundBookRole,
  extractSourceSid,
  isStorefrontSetKey,
  normalizePairLabel,
} from './algofundSync';

describe('algofundSync helpers', () => {
  it('extracts source SID from copy strategy names', () => {
    assert.equal(
      extractSourceSid('SAAS::icopy1::SYNTHETIC::ZZ_Fast::BCHUSDT/APEUSDT::SID254531'),
      '254531',
    );
    assert.equal(extractSourceSid('plain-name'), '');
  });

  it('treats portfolio-* as storefront setKeys, not TS names', () => {
    assert.equal(isStorefrontSetKey('portfolio-balanced-jul2026'), true);
    assert.equal(isStorefrontSetKey('portfolio-conservative-jul2026'), true);
    assert.equal(isStorefrontSetKey('ALGOFUND::icopy1::b3'), false);
    assert.equal(isStorefrontSetKey('ALGOFUND::icopy1'), false);
    assert.equal(isStorefrontSetKey(''), false);
  });

  it('labels synth as BASE/QUOTE so quote legs are not double-counted', () => {
    assert.equal(normalizePairLabel('BCHUSDT', 'APEUSDT', 'synthetic'), 'BCHUSDT/APEUSDT');
    assert.equal(normalizePairLabel('BCH/USDT', 'APE-USDT', 'synthetic'), 'BCHUSDT/APEUSDT');
    assert.equal(normalizePairLabel('SPXUSDT', '', 'mono'), 'SPXUSDT');
    assert.equal(normalizePairLabel('SPXUSDT', 'SPXUSDT', 'synthetic'), 'SPXUSDT');
  });

  it('extracts book role from ALGOFUND::{slug}::{role}', () => {
    assert.equal(extractAlgofundBookRole('ALGOFUND::icopy1::b3', 'icopy1'), 'b3');
    assert.equal(extractAlgofundBookRole('ALGOFUND::icopy1::ham', 'icopy1'), 'ham');
    assert.equal(extractAlgofundBookRole('ALGOFUND::icopy1', 'icopy1'), '');
  });
});
