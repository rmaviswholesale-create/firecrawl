import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  urlMatchesPattern,
  validateActions,
  validateUrlPattern,
} from './interact';

describe('validateActions', () => {
  it('accepts a missing or well-formed action list', () => {
    assert.equal(validateActions(undefined), undefined);
    assert.equal(
      validateActions([
        { type: 'click', selector: '#a' },
        { type: 'wait', milliseconds: 10 },
      ]),
      undefined,
    );
  });

  it('rejects payloads that are not action lists', () => {
    assert.match(validateActions('click') ?? '', /must be an array/);
    assert.match(validateActions([null]) ?? '', /must be an object/);
    assert.match(
      validateActions([{ type: 'teleport' }]) ?? '',
      /unsupported type "teleport"/,
    );
  });

  it('rejects more screenshot and pdf steps than fit in memory', () => {
    const actions = Array.from({ length: 11 }, () => ({ type: 'screenshot' }));
    assert.match(validateActions(actions) ?? '', /more than 10 screenshot or pdf/);
  });

  it('rejects more actions than the service will run', () => {
    const actions = Array.from({ length: 51 }, () => ({ type: 'scrape' }));
    assert.match(validateActions(actions) ?? '', /cannot exceed 50/);
  });
});

describe('urlMatchesPattern', () => {
  it('matches text anywhere in the URL', () => {
    assert.equal(urlMatchesPattern('https://example.com/api/v2/items', '/api/'), true);
    assert.equal(urlMatchesPattern('https://example.com/static/app.js', '/api/'), false);
  });

  it('treats * as any run of characters, in order', () => {
    const url = 'https://example.com/api/v2/items?page=3';
    assert.equal(urlMatchesPattern(url, '/api/*/items'), true);
    assert.equal(urlMatchesPattern(url, 'items*api'), false);
    assert.equal(urlMatchesPattern(url, '*'), true);
  });

  it('treats regex syntax as plain text', () => {
    assert.equal(urlMatchesPattern('https://example.com/a+b', '(a+)+$'), false);
    assert.equal(urlMatchesPattern('https://example.com/(a+)+$', '(a+)+$'), true);
  });

  it('stays fast on input that makes a backtracking regex hang', () => {
    const started = Date.now();
    urlMatchesPattern('a'.repeat(100_000) + '!', 'a*a*a*a*a*a*a*a*b');
    assert.ok(Date.now() - started < 1000);
  });
});

describe('validateUrlPattern', () => {
  it('accepts a missing or ordinary pattern', () => {
    assert.equal(validateUrlPattern(undefined), undefined);
    assert.equal(validateUrlPattern('/api/'), undefined);
  });

  it('rejects a non-string or oversized pattern', () => {
    assert.match(validateUrlPattern(5) ?? '', /must be a string/);
    assert.match(validateUrlPattern('a'.repeat(501)) ?? '', /too long/);
  });
});
