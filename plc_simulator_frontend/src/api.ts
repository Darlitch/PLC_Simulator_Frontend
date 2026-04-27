import type {
  ApiErrorResponse,
  GeneratedSourcesResponse,
  LoadModelPayload,
  SimulationSnapshot,
  SimulationStatus,
  UpdateInputsPayload,
} from './types'
import { getOrCreateSessionId } from './session'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

function normalizeApiError(payload: ApiErrorResponse): string {
  const message = payload.message?.trim()
  const details = payload.details?.trim()

  if (message && details && details !== message) {
    return `${message}
${details}`
  }

  if (message) {
    return message
  }

  return 'Request failed'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Session-Id': getOrCreateSessionId(),
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const contentType = response.headers.get('content-type') ?? ''

  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as Partial<ApiErrorResponse>
      throw new Error(normalizeApiError({
        code: payload.code ?? 'REQUEST_FAILED',
        message: payload.message ?? `Request failed with status ${response.status}`,
        details: payload.details ?? null,
      }))
    }

    const text = (await response.text()).trim()
    throw new Error(text || `Request failed with status ${response.status}`)
  }

  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>
  }

  return response.text() as T
}

export const api = {
  loadModel(payload: LoadModelPayload) {
    return request<SimulationSnapshot>('/api/model/load', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  reloadModel() {
    return request<SimulationSnapshot>('/api/model/reload', {
      method: 'POST',
    })
  },

  getGeneratedSources() {
    return request<GeneratedSourcesResponse>('/api/model/generated-sources')
  },

  start() {
    return request<SimulationSnapshot>('/api/simulation/start', {
      method: 'POST',
    })
  },

  pause() {
    return request<SimulationSnapshot>('/api/simulation/pause', {
      method: 'POST',
    })
  },

  resume() {
    return request<SimulationSnapshot>('/api/simulation/resume', {
      method: 'POST',
    })
  },

  stop() {
    return request<SimulationSnapshot>('/api/simulation/stop', {
      method: 'POST',
    })
  },

  step() {
    return request<SimulationSnapshot>('/api/simulation/step', {
      method: 'POST',
    })
  },

  getState() {
    return request<SimulationSnapshot>('/api/simulation/state')
  },

  getStatus() {
    return request<SimulationStatus>('/api/simulation/status')
  },

  updateInputs(payload: UpdateInputsPayload) {
    return request<SimulationSnapshot>('/api/simulation/inputs', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}
