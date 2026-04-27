export type SimulationStatus = 'STOPPED' | 'RUNNING' | 'PAUSED'

export type ScalarValue = string | number | boolean | null

export type ValueMap = Record<string, ScalarValue>

export interface SimulationSnapshot {
  modelPath: string | null
  status: SimulationStatus
  inputs: ValueMap
  outputs: ValueMap
  globals: ValueMap
  vars: ValueMap
  processStates: Record<string, string>
  processTimers: Record<string, number>
}

export interface GeneratedSourcesResponse {
  programFileName: string | null
  files: Record<string, string>
}

export interface ApiErrorResponse {
  code: string
  message: string
  details: string | null
}

export interface LoadModelPayload {
  modelName: string
  source: string
}

export interface UpdateInputsPayload {
  values: ValueMap
}
