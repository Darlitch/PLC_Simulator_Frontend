import type {
  LoadModelPayload,
  SimulationSnapshot,
  SimulationStatus,
  UpdateInputsPayload,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed with status ${response.status}`)
  }

  const contentType = response.headers.get('content-type') ?? ''

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
