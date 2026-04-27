const SESSION_STORAGE_KEY = 'plc-simulator-session-id'

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function getOrCreateSessionId(): string {
  const existing = window.localStorage.getItem(SESSION_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const sessionId = createSessionId()
  window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  return sessionId
}
