/**
 * In-memory session manager for step-by-step input flows.
 * Lost on bot restart — acceptable per spec.
 */
class SessionManager {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.sessions = new Map();
    this.ttl = ttlMs;
    // Cleanup every 2 minutes
    setInterval(() => this.cleanup(), 120000);
  }

  set(telegramId, data) {
    const entry = {
      ...data,
      telegramId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl,
    };
    this.sessions.set(telegramId, entry);
    return entry;
  }

  get(telegramId) {
    const s = this.sessions.get(telegramId);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(telegramId);
      return null;
    }
    return s;
  }

  delete(telegramId) {
    this.sessions.delete(telegramId);
  }

  has(telegramId) {
    return this.get(telegramId) !== null;
  }

  cleanup() {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now > v.expiresAt) this.sessions.delete(k);
    }
  }
}

module.exports = new SessionManager();
