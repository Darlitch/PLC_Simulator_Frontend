import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import './App.css'
import { messages, type Locale } from './i18n'
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
  labels: typeof messages.en
  subtitle: string
  data: SectionRecord
  accent?: 'cyan' | 'amber' | 'rose' | 'violet'
}

function DataPanel({ labels, subtitle, data, accent = 'cyan' }: DataPanelProps) {
  const entries = sortEntries(data)

  return (
    <section className={`panel data-panel accent-${accent}`}>
      <header className="panel-header">
        <div>
          <p className="eyebrow">{subtitle}</p>
        </div>
        <span className="pill">{entries.length}</span>
      </header>

      <div className="table-shell">
        {entries.length === 0 ? (
          <div className="empty-state">{labels.noDataYet}</div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>{labels.name}</th>
                <th>{labels.value}</th>
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
  const [locale, setLocale] = useState<Locale>('ru')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [modelName, setModelName] = useState(DEFAULT_MODEL_NAME)
  const [source, setSource] = useState(DEFAULT_SOURCE)
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null)
  const [status, setStatus] = useState<SimulationStatus | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState(messages.ru.ready)
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({})
  const [selectedInputs, setSelectedInputs] = useState<Record<string, boolean>>({})
  const [pollIntervalMs, setPollIntervalMs] = useState(1000)
  const [showFloatingAction, setShowFloatingAction] = useState(false)

  const inputEntries = useMemo(() => sortEntries(snapshot?.inputs), [snapshot])
  const pollTimerRef = useRef<number | null>(null)
  const t = messages[locale]

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const handleScroll = () => {
      setShowFloatingAction(window.scrollY > 260)
    }

    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })

    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

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
    if (!snapshot) {
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
        setError(pollError instanceof Error ? pollError.message : t.pollingFailed)
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
  }, [pollIntervalMs, snapshot, t.pollingFailed])

  async function withBusyState<T>(action: () => Promise<T>, onSuccess?: (value: T) => void) {
    setIsBusy(true)
    setError(null)

    try {
      const result = await action()
      onSuccess?.(result)
      return result
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t.unexpectedError)
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
        setSuccessMessage(`${t.loaded} ${formatModelPath(nextSnapshot.modelPath)}`)
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
      setError(t.loadModelFirst)
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
      setError(t.selectAtLeastOneInput)
      return
    }

    await withBusyState(
      () => api.updateInputs({ values }),
      (nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setStatus(nextSnapshot.status)
        setSuccessMessage(`${t.appliedInputChanges}: ${Object.keys(values).length}`)
      },
    )
  }

  const activeInputCount = useMemo(
    () => Object.values(selectedInputs).filter(Boolean).length,
    [selectedInputs],
  )

  const floatingAction = useMemo(() => {
    if (!snapshot) return null

    if (status === 'RUNNING') {
      return {
        label: t.pause,
        icon: 'Ⅱ',
        onClick: () => void handleLifecycleAction(() => api.pause(), t.simulationPaused),
      }
    }

    if (status === 'PAUSED') {
      return {
        label: t.resume,
        icon: '▶',
        onClick: () => void handleLifecycleAction(() => api.resume(), t.simulationResumed),
      }
    }

    return {
      label: t.start,
      icon: '▶',
      onClick: () => void handleLifecycleAction(() => api.start(), t.simulationStarted),
    }
  }, [snapshot, status, t.pause, t.resume, t.start, t.simulationPaused, t.simulationResumed, t.simulationStarted])

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PLC</div>
          <div>
            <h1>{t.appTitle}</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <div className="topbar-settings">
            <div className="settings-chip">
              <span className="settings-label">{t.language}</span>
              <select
                className="settings-select"
                value={locale}
                onChange={(event) => setLocale(event.target.value as Locale)}
              >
                <option value="ru">RU</option>
                <option value="en">EN</option>
              </select>
            </div>

            <div className="settings-divider" />

            <div className="settings-chip">
              <span className="settings-label">{t.interval}</span>
              <select
                className="settings-select"
                value={pollIntervalMs}
                onChange={(event) => setPollIntervalMs(Number(event.target.value))}
              >
                <option value={500}>500 ms</option>
                <option value={1000}>1 s</option>
                <option value={2000}>2 s</option>
              </select>
            </div>

            <div className="settings-divider" />

            <button
              className="icon-button header-icon-button"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              type="button"
              title={t.theme}
              aria-label={t.theme}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="panel editor-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">{t.modelSource}</p>
            </div>
            <span className="pill">
              {source.length.toLocaleString()} {t.chars}
            </span>
          </header>

          <div className="editor-toolbar">
            <label className="field">
              <span>{t.modelName}</span>
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
              {t.loadModel}
            </button>
            <button
              className="ghost-button"
              disabled={isBusy || !snapshot}
              onClick={() => void handleLifecycleAction(() => api.reloadModel(), t.reloadedCurrent)}
            >
              {t.reloadCurrent}
            </button>
          </div>
        </section>

        <div className="side-column">
          <section className="panel control-panel">
            <header className="panel-header">
              <p className="eyebrow">{t.lifecycle}</p>

              <div className="control-header-meta">
                <div className="header-model compact">
                  <span className="header-model-label">{t.model}</span>
                  <strong title={formatModelPath(snapshot?.modelPath ?? null)}>
                    {formatModelPath(snapshot?.modelPath ?? null) || t.noModelLoaded}
                  </strong>
                </div>

                <div className={`status-card inline compact status-inline ${statusTone(status)}`}>
                  <span className="status-dot" />
                  <strong>{status ?? t.notLoaded}</strong>
                </div>
              </div>
            </header>

            <div className="control-grid">
              <button
                className="primary-button"
                disabled={isBusy || !snapshot}
                onClick={() => void handleLifecycleAction(() => api.start(), t.simulationStarted)}
              >
                {t.start}
              </button>
              <button
                className="ghost-button"
                disabled={isBusy || !snapshot}
                onClick={() => void handleLifecycleAction(() => api.pause(), t.simulationPaused)}
              >
                {t.pause}
              </button>
              <button
                className="ghost-button"
                disabled={isBusy || !snapshot}
                onClick={() => void handleLifecycleAction(() => api.resume(), t.simulationResumed)}
              >
                {t.resume}
              </button>
              <button
                className="ghost-button"
                disabled={isBusy || !snapshot}
                onClick={() => void handleLifecycleAction(() => api.stop(), t.simulationStopped)}
              >
                {t.stop}
              </button>
              <button
                className="ghost-button"
                disabled={isBusy || !snapshot}
                onClick={() => void handleLifecycleAction(() => api.step(), t.singleStepExecuted)}
              >
                {t.singleStep}
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
                <p className="eyebrow">{t.inputControl}</p>
              </div>
            </header>

            <div className="input-list">
              {inputEntries.length === 0 ? (
                <div className="empty-state">{t.noInputsYet}</div>
              ) : (
                inputEntries.map(([key, value]) => {
                  const kind = inferInputKind(value)
                  const checked = selectedInputs[key] ?? false

                  return (
                    <div className="input-row" key={key}>
                      <label className="checkbox-wrap">
                        <input
                          className="input-checkbox"
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            setSelectedInputs((current) => ({ ...current, [key]: event.target.checked }))
                          }
                        />
                      </label>

                      <div className="input-name" title={key}>
                        {key}
                      </div>

                      <div className="input-current">
                        {t.current}: {String(value)}
                      </div>

                      {kind === 'boolean' ? (
                        <select
                          className="input-editor"
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
                          className="input-editor"
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
                {t.applySelectedInputs}
              </button>
              <button
                className="ghost-button"
                disabled={isBusy || inputEntries.length === 0}
                onClick={() => {
                  setSelectedInputs(Object.fromEntries(inputEntries.map(([key]) => [key, false])))
                  setSuccessMessage(t.selectionCleared)
                }}
              >
                {t.clearSelection}
              </button>
            </div>
          </section>
        </div>

        <section className="data-grid">
          <DataPanel labels={t} subtitle={t.inputs} data={snapshot?.inputs ?? {}} accent="cyan" />
          <DataPanel labels={t} subtitle={t.outputs} data={snapshot?.outputs ?? {}} accent="amber" />
          <DataPanel labels={t} subtitle={t.globals} data={snapshot?.globals ?? {}} accent="violet" />
          <DataPanel labels={t} subtitle={t.vars} data={snapshot?.vars ?? {}} accent="rose" />
          <DataPanel labels={t} subtitle={t.processStates} data={snapshot?.processStates ?? {}} accent="cyan" />
          <DataPanel labels={t} subtitle={t.processTimers} data={snapshot?.processTimers ?? {}} accent="amber" />
        </section>
      </main>

      {showFloatingAction && floatingAction ? (
        <div className="floating-toolbar">
          <span
            className={`floating-status-dot ${statusTone(status)}`}
            title={status ?? t.notLoaded}
            aria-label={status ?? t.notLoaded}
          />

          <button
            className="floating-tool floating-tool-primary"
            type="button"
            onClick={floatingAction.onClick}
            disabled={isBusy}
            title={floatingAction.label}
            aria-label={floatingAction.label}
          >
            {floatingAction.icon}
          </button>

          <button
            className="floating-tool"
            type="button"
            onClick={() => void handleLifecycleAction(() => api.stop(), t.simulationStopped)}
            disabled={isBusy || !snapshot}
            title={t.stop}
            aria-label={t.stop}
          >
            ■
          </button>

          <button
            className="floating-tool"
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            title="Up"
            aria-label="Up"
          >
            ↑
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default App
