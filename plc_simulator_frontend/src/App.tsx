import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import './App.css'
import type { ScalarValue, SimulationSnapshot, SimulationStatus, ValueMap } from './types'

const DEFAULT_MODEL_NAME = 'traffic'
const DEFAULT_SOURCE = ''

function inferInputKind(value: ScalarValue): 'boolean' | 'number' | 'text' {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'text'
}

function formatModelPath(modelPath: string | null): string {
  if (!modelPath) return 'No model loaded'

  try {
    const url = new URL(modelPath)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.at(-1) ?? modelPath
  } catch {
    return modelPath
  }
}

function statusTone(status: SimulationStatus | null): string {
  switch (status) {
    case 'RUNNING':
      return 'is-running'
    case 'PAUSED':
      return 'is-paused'
    case 'STOPPED':
      return 'is-stopped'
    default:
      return ''
  }
}

function sortEntries<T>(record: Record<string, T> | undefined): Array<[string, T]> {
  return Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))
}

function parseDraftValue(raw: string, kind: 'boolean' | 'number' | 'text'): ScalarValue {
  if (kind === 'boolean') return raw === 'true'
  if (kind === 'number') {
    const parsed = Number(raw)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return raw
}

type SectionRecord = Record<string, ScalarValue> | Record<string, number> | Record<string, string>

interface DataPanelProps {
  title: string
  subtitle: string
  data: SectionRecord
  accent?: 'cyan' | 'amber' | 'rose' | 'violet'
}

function DataPanel({ title, subtitle, data, accent = 'cyan' }: DataPanelProps) {
  const entries = sortEntries(data)

  return (
    <section className={`panel data-panel accent-${accent}`}>
      <header className="panel-header">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <h3>{title}</h3>
        </div>
        <span className="pill">{entries.length}</span>
      </header>

      <div className="table-shell">
        {entries.length === 0 ? (
          <div className="empty-state">No data yet</div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <td className="key-cell">{key}</td>
                  <td>{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [modelName, setModelName] = useState(DEFAULT_MODEL_NAME)
  const [source, setSource] = useState(DEFAULT_SOURCE)
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null)
  const [status, setStatus] = useState<SimulationStatus | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState('Ready')
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({})
  const [selectedInputs, setSelectedInputs] = useState<Record<string, boolean>>({})
  const [pollingEnabled, setPollingEnabled] = useState(true)
  const [pollIntervalMs, setPollIntervalMs] = useState(1000)

  const inputEntries = useMemo(() => sortEntries(snapshot?.inputs), [snapshot])
  const pollTimerRef = useRef<number | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (!snapshot) {
      setDraftInputs({})
      setSelectedInputs({})
      return
    }

    setDraftInputs((current) => {
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(snapshot.inputs)) {
        next[key] = current[key] ?? String(value)
      }
      return next
    })

    setSelectedInputs((current) => {
      const next: Record<string, boolean> = {}
      for (const key of Object.keys(snapshot.inputs)) {
        next[key] = current[key] ?? false
      }
      return next
    })
  }, [snapshot])

  useEffect(() => {
    if (!pollingEnabled || !snapshot) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      return
    }

    pollTimerRef.current = window.setInterval(async () => {
      try {
        setIsRefreshing(true)
        const nextSnapshot = await api.getState()
        setSnapshot(nextSnapshot)
        setStatus(nextSnapshot.status)
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : 'Polling failed')
      } finally {
        setIsRefreshing(false)
      }
    }, pollIntervalMs)

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [pollingEnabled, pollIntervalMs, snapshot])

  async function withBusyState<T>(action: () => Promise<T>, onSuccess?: (value: T) => void) {
    setIsBusy(true)
    setError(null)

    try {
      const result = await action()
      onSuccess?.(result)
      return result
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unexpected error')
      return undefined
    } finally {
      setIsBusy(false)
    }
  }

  async function handleLoadModel() {
    await withBusyState(
      () => api.loadModel({ modelName, source }),
      (nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setStatus(nextSnapshot.status)
        setSuccessMessage(`Loaded ${formatModelPath(nextSnapshot.modelPath)}`)
      },
    )
  }

  async function handleLifecycleAction(action: () => Promise<SimulationSnapshot>, message: string) {
    await withBusyState(action, (nextSnapshot) => {
      setSnapshot(nextSnapshot)
      setStatus(nextSnapshot.status)
      setSuccessMessage(message)
    })
  }

  async function handleApplySelectedInputs() {
    if (!snapshot) {
      setError('Load a model first')
      return
    }

    const values: ValueMap = {}
    for (const [key, selected] of Object.entries(selectedInputs)) {
      if (!selected) continue
      const currentValue = snapshot.inputs[key]
      const kind = inferInputKind(currentValue)
      values[key] = parseDraftValue(draftInputs[key] ?? String(currentValue), kind)
    }

    if (Object.keys(values).length === 0) {
      setError('Select at least one input variable to apply')
      return
    }

    await withBusyState(
      () => api.updateInputs({ values }),
      (nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setStatus(nextSnapshot.status)
        setSuccessMessage(`Applied ${Object.keys(values).length} input change(s)`)
      },
    )
  }

  const activeInputCount = useMemo(
    () => Object.values(selectedInputs).filter(Boolean).length,
    [selectedInputs],
  )

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PLC</div>
          <div>
            <p className="eyebrow">Simulation Control Desk</p>
            <h1>PLC Simulator Frontend</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <label className="toggle">
            <span>Auto refresh</span>
            <input
              type="checkbox"
              checked={pollingEnabled}
              onChange={(event) => setPollingEnabled(event.target.checked)}
            />
          </label>

          <label className="mini-field">
            <span>Interval</span>
            <select value={pollIntervalMs} onChange={(event) => setPollIntervalMs(Number(event.target.value))}>
              <option value={500}>500 ms</option>
              <option value={1000}>1 s</option>
              <option value={2000}>2 s</option>
            </select>
          </label>

          <button className="ghost-button" onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))} type="button">
            {theme === 'dark' ? 'Light Theme' : 'Dark Theme'}
          </button>
        </div>
      </header>

      <section className="hero-strip">
        <div className="hero-copy">
          <p className="eyebrow">Backend-driven simulator UI</p>
          <h2>Load a poST model, run the engine, watch state update live.</h2>
          <p className="lead">
            The frontend stays disposable. Everything important lives behind your existing API.
          </p>
        </div>

        <div className="status-cluster">
          <div className={`status-card ${statusTone(status)}`}>
            <span className="status-dot" />
            <div>
              <p className="eyebrow">Engine status</p>
              <strong>{status ?? 'NOT LOADED'}</strong>
            </div>
          </div>
          <div className="status-card">
            <div>
              <p className="eyebrow">Model</p>
              <strong>{formatModelPath(snapshot?.modelPath ?? null)}</strong>
            </div>
          </div>
          <div className="status-card">
            <div>
              <p className="eyebrow">Refresh</p>
              <strong>{isRefreshing ? 'Syncing...' : pollingEnabled ? 'Live' : 'Manual'}</strong>
            </div>
          </div>
        </div>
      </section>

      <main className="dashboard-grid">
        <section className="panel editor-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Model source</p>
              <h3>poST Loader</h3>
            </div>
            <span className="pill">{source.length.toLocaleString()} chars</span>
          </header>

          <div className="editor-toolbar">
            <label className="field">
              <span>Model name</span>
              <input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="traffic" />
            </label>
          </div>

          <textarea
            className="source-editor"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
          />

          <div className="editor-actions">
            <button className="primary-button" disabled={isBusy} onClick={() => void handleLoadModel()}>
              Load Model
            </button>
            <button
              className="ghost-button"
              disabled={isBusy || !snapshot}
              onClick={() => void handleLifecycleAction(() => api.reloadModel(), 'Reloaded current model')}
            >
              Reload Current
            </button>
          </div>
        </section>

        <section className="panel control-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Lifecycle</p>
              <h3>Engine Controls</h3>
            </div>
            <span className="pill">{status ?? 'IDLE'}</span>
          </header>

          <div className="control-grid">
            <button className="primary-button" disabled={isBusy || !snapshot} onClick={() => void handleLifecycleAction(() => api.start(), 'Simulation started')}>
              Start
            </button>
            <button className="ghost-button" disabled={isBusy || !snapshot} onClick={() => void handleLifecycleAction(() => api.pause(), 'Simulation paused')}>
              Pause
            </button>
            <button className="ghost-button" disabled={isBusy || !snapshot} onClick={() => void handleLifecycleAction(() => api.resume(), 'Simulation resumed')}>
              Resume
            </button>
            <button className="ghost-button" disabled={isBusy || !snapshot} onClick={() => void handleLifecycleAction(() => api.stop(), 'Simulation stopped')}>
              Stop
            </button>
            <button className="ghost-button" disabled={isBusy || !snapshot} onClick={() => void handleLifecycleAction(() => api.step(), 'Single step executed')}>
              Single Step
            </button>
            <button
              className="ghost-button"
              disabled={isBusy || !snapshot}
              onClick={() =>
                void withBusyState(() => api.getState(), (nextSnapshot) => {
                  setSnapshot(nextSnapshot)
                  setStatus(nextSnapshot.status)
                  setSuccessMessage('Snapshot refreshed')
                })
              }
            >
              Refresh Snapshot
            </button>
          </div>

          <div className="message-stack">
            <div className="message success">{successMessage}</div>
            {error && <div className="message error">{error}</div>}
          </div>
        </section>

        <section className="panel input-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Input control</p>
              <h3>Selected Inputs Only</h3>
            </div>
            <span className="pill">{activeInputCount} queued</span>
          </header>

          <div className="input-list">
            {inputEntries.length === 0 ? (
              <div className="empty-state">Load a model to inspect its input variables.</div>
            ) : (
              inputEntries.map(([key, value]) => {
                const kind = inferInputKind(value)
                const checked = selectedInputs[key] ?? false

                return (
                  <div className="input-row" key={key}>
                    <label className="checkbox-wrap">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setSelectedInputs((current) => ({ ...current, [key]: event.target.checked }))
                        }
                      />
                      <span>{key}</span>
                    </label>

                    <div className="input-current">Current: {String(value)}</div>

                    {kind === 'boolean' ? (
                      <select
                        value={draftInputs[key] ?? String(value)}
                        onChange={(event) =>
                          setDraftInputs((current) => ({ ...current, [key]: event.target.value }))
                        }
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input
                        type={kind === 'number' ? 'number' : 'text'}
                        value={draftInputs[key] ?? String(value)}
                        onChange={(event) =>
                          setDraftInputs((current) => ({ ...current, [key]: event.target.value }))
                        }
                      />
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className="editor-actions">
            <button
              className="primary-button"
              disabled={isBusy || !snapshot || activeInputCount === 0}
              onClick={() => void handleApplySelectedInputs()}
            >
              Apply Selected Inputs
            </button>
            <button
              className="ghost-button"
              disabled={isBusy || inputEntries.length === 0}
              onClick={() => {
                setSelectedInputs(Object.fromEntries(inputEntries.map(([key]) => [key, false])))
                setSuccessMessage('Selection cleared')
              }}
            >
              Clear Selection
            </button>
          </div>
        </section>

        <DataPanel title="Inputs" subtitle="Live view" data={snapshot?.inputs ?? {}} accent="cyan" />
        <DataPanel title="Outputs" subtitle="Live view" data={snapshot?.outputs ?? {}} accent="amber" />
        <DataPanel title="Globals" subtitle="Shared memory" data={snapshot?.globals ?? {}} accent="violet" />
        <DataPanel title="Vars" subtitle="Program vars" data={snapshot?.vars ?? {}} accent="rose" />
        <DataPanel title="Process States" subtitle="Lifecycle" data={snapshot?.processStates ?? {}} accent="cyan" />
        <DataPanel title="Process Timers" subtitle="Timing" data={snapshot?.processTimers ?? {}} accent="amber" />
      </main>
    </div>
  )
}

export default App
