import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileUrlPattern, validateActions } from './interact';

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

  it('rejects more actions than the service will run', () => {
    const actions = Array.from({ length: 51 }, () => ({ type: 'scrape' }));
    assert.match(validateActions(actions) ?? '', /cannot exceed 50/);
  });
});

describe('compileUrlPattern', () => {
  it('compiles a valid pattern and passes through an absent one', () => {
    assert.deepEqual(compileUrlPattern(undefined), {});
    const { regex, error } = compileUrlPattern('/api/v\\d+/');
    assert.equal(error, undefined);
    assert.equal(regex?.test('https://example.com/api/v2/items'), true);
  });

  it('reports an invalid pattern instead of throwing', () => {
    assert.match(compileUrlPattern('(').error ?? '', /not a valid regex/);
  });
});
