import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/services/circuitBreaker.js';

test('opens after threshold, half-opens after cooldown, closes on success', () => {
  let t = 0;
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
  assert.equal(b.canRequest(), true);
  b.failure();
  assert.equal(b.state, 'closed');
  b.failure();
  assert.equal(b.state, 'open');
  assert.equal(b.canRequest(), false);
  t = 1001;
  assert.equal(b.canRequest(), true); // probe allowed
  assert.equal(b.state, 'half_open');
  assert.equal(b.canRequest(), false); // only one probe at a time
  b.success();
  assert.equal(b.state, 'closed');
});

test('failed probe re-opens the circuit', () => {
  let t = 0;
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
  b.failure();
  t = 150;
  assert.equal(b.canRequest(), true);
  b.failure();
  assert.equal(b.state, 'open');
  assert.equal(b.canRequest(), false);
});
