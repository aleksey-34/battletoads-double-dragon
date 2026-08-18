import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearProcessedClosedBarMemory,
  closedBarDedupeKey,
  hydrateProcessedClosedBarMemory,
  isClosedBarAlreadyProcessed,
  rememberProcessedClosedBar,
} from './closedBarDedupe';
import { intervalToMs } from './normalize';

describe('closed-bar dedupe memory (restart watermark)', () => {
  beforeEach(() => {
    clearProcessedClosedBarMemory();
  });

  it('hydrates DB watermark so the same closed bar is skipped after a cold start', () => {
    const key = closedBarDedupeKey('Copy_Alex1', 256578);
    const barMs = Date.parse('2026-08-13T12:00:00Z');
    assert.equal(isClosedBarAlreadyProcessed(key, barMs), false);

    hydrateProcessedClosedBarMemory(key, barMs);
    assert.equal(isClosedBarAlreadyProcessed(key, barMs), true);
    assert.equal(isClosedBarAlreadyProcessed(key, barMs + 4 * 3600_000), false);
  });

  it('does not rewind memory when a stale persist arrives', () => {
    const key = closedBarDedupeKey('arcopy1', 1);
    rememberProcessedClosedBar(key, 2_000);
    hydrateProcessedClosedBarMemory(key, 1_000);
    assert.equal(isClosedBarAlreadyProcessed(key, 2_000), true);
    // watermark is >= : a stale older bar must not re-fire
    assert.equal(isClosedBarAlreadyProcessed(key, 1_000), true);
  });

  it('remember is monotonic', () => {
    const key = closedBarDedupeKey('icopy1-api', 9);
    rememberProcessedClosedBar(key, 5_000);
    rememberProcessedClosedBar(key, 4_000);
    assert.equal(isClosedBarAlreadyProcessed(key, 5_000), true);
    rememberProcessedClosedBar(key, 6_000);
    assert.equal(isClosedBarAlreadyProcessed(key, 6_000), true);
  });
});

describe('intervalToMs canonical hours', () => {
  it('treats 4H / 4h as four hours, not one', () => {
    assert.equal(intervalToMs('4h'), 4 * 3600_000);
    assert.equal(intervalToMs('4H'), 4 * 3600_000);
    assert.equal(intervalToMs('1h'), 3600_000);
  });
});
