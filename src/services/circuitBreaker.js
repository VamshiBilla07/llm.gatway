/**
 * Classic 3-state circuit breaker.
 *  closed    -> normal traffic
 *  open      -> provider is skipped until cooldown passes
 *  half_open -> exactly one probe request is allowed; success closes, failure re-opens
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30000, now = Date.now } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  canRequest() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.state = 'half_open';
      this.probing = true;
      return true;
    }
    // half_open: only one in-flight probe
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
    this.probing = false;
  }

  failure() {
    this.probing = false;
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  snapshot() {
    return { state: this.state, failures: this.failures };
  }
}
