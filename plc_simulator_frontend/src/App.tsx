import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { api } from './api'
import Editor from '@monaco-editor/react'
import './App.css'
import { messages, type Locale } from './i18n'
import { getOrCreateSessionId } from './session'
import type {
  GeneratedSourcesResponse,
  ScalarValue,
  SimulationSnapshot,
  SimulationStatus,
  ValueMap,
} from './types'

const DEFAULT_MODEL_NAME = 'traffic'
const DEFAULT_SOURCE = ''

type EditorViewMode = 'post' | 'java'

function editorStateKey(suffix: 'model-name' | 'source'): string {
  return `plc-simulator-${getOrCreateSessionId()}-${suffix}`
}

function loadStoredEditorState(): { modelName: string; source: string } {
  return {
    modelName: window.localStorage.getItem(editorStateKey('model-name')) ?? DEFAULT_MODEL_NAME,
    source: window.localStorage.getItem(editorStateKey('source')) ?? DEFAULT_SOURCE,
  }
}

function persistEditorState(modelName: string, source: string): void {
  window.localStorage.setItem(editorStateKey('model-name'), modelName)
  window.localStorage.setItem(editorStateKey('source'), source)
}

function deriveModelName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || DEFAULT_MODEL_NAME
}

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

function sortGeneratedSourceFiles(fileNames: string[], programFileName: string | null): string[] {
  const priority = ['Simulation.java', programFileName, 'BaseProcess.java', 'IProcess.java'].filter(
    (value): value is string => Boolean(value),
  )

  const prioritySet = new Set(priority)
  const tail = fileNames
    .filter((fileName) => !prioritySet.has(fileName))
    .sort((left, right) => left.localeCompare(right))

  return [...priority.filter((fileName) => fileNames.includes(fileName)), ...tail]
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
  const initialEditorState = useMemo(() => loadStoredEditorState(), [])
  const [modelName, setModelName] = useState(initialEditorState.modelName)
  const [source, setSource] = useState(initialEditorState.source)
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>('post')
  const [generatedSources, setGeneratedSources] = useState<Record<string, string>>({})
  const [programJavaFile, setProgramJavaFile] = useState<string | null>(null)
  const [activeJavaFile, setActiveJavaFile] = useState<string | null>(null)
  const [isGeneratedSourcesLoading, setIsGeneratedSourcesLoading] = useState(false)
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
  const generatedSourceFileNames = useMemo(
    () => sortGeneratedSourceFiles(Object.keys(generatedSources), programJavaFile),
    [generatedSources, programJavaFile],
  )
  const activeJavaSource = activeJavaFile ? generatedSources[activeJavaFile] ?? '' : ''
  const pollTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const t = messages[locale]
  const editorTabLabels = locale === 'ru'
    ? {
        post: 'poST-код',
        java: 'Java-код',
        generated: 'Сгенерированный Java-код',
        javaEmpty: 'Сначала загрузите модель, чтобы увидеть сгенерированный Java-код.',
        javaMissing: 'Для текущей модели не найдено сгенерированных .java файлов.',
        javaLoadFailed: 'Не удалось получить сгенерированный Java-код',
        filesWord: 'файла',
      }
    : {
        post: 'poST code',
        java: 'Java code',
        generated: 'Generated Java sources',
        javaEmpty: 'Load a model first to inspect its generated Java code.',
        javaMissing: 'No generated .java files were found for the current model.',
        javaLoadFailed: 'Failed to load generated Java sources',
        filesWord: 'files',
      }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    persistEditorState(modelName, source)
  }, [modelName, source])

  async function loadGeneratedSources(preferredFileName?: string | null): Promise<void> {
    setIsGeneratedSourcesLoading(true)

    try {
      const nextSources: GeneratedSourcesResponse = await api.getGeneratedSources()
      const orderedFiles = sortGeneratedSourceFiles(Object.keys(nextSources.files), nextSources.programFileName)

      setGeneratedSources(nextSources.files)
      setProgramJavaFile(nextSources.programFileName)
      setActiveJavaFile((current) => {
        if (preferredFileName && nextSources.files[preferredFileName]) return preferredFileName
        if (current && nextSources.files[current]) return current
        return orderedFiles[0] ?? null
      })
    } catch (generatedError) {
      setError(generatedError instanceof Error ? generatedError.message : editorTabLabels.javaLoadFailed)
    } finally {
      setIsGeneratedSourcesLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const restoreSessionState = async () => {
      try {
        const nextSnapshot = await api.getState()

        if (cancelled) return

        setSnapshot(nextSnapshot)
        setStatus(nextSnapshot.status)

        const hasRuntimeState = nextSnapshot.modelPath !== null

        if (hasRuntimeState) {
          setSuccessMessage(`${t.loaded} ${formatModelPath(nextSnapshot.modelPath)}`)
          void loadGeneratedSources()
        } else {
          setGeneratedSources({})
          setProgramJavaFile(null)
          setActiveJavaFile(null)
        }
      } catch (restoreError) {
        if (cancelled) return
        setError(restoreError instanceof Error ? restoreError.message : t.unexpectedError)
      }
    }

    void restoreSessionState()

    return () => {
      cancelled = true
    }
  }, [t.loaded, t.unexpectedError])

  useEffect(() => {
    if (editorViewMode !== 'java' || !snapshot?.modelPath || isGeneratedSourcesLoading || generatedSourceFileNames.length > 0) {
      return
    }

    void loadGeneratedSources()
  }, [editorViewMode, generatedSourceFileNames.length, isGeneratedSourcesLoading, snapshot?.modelPath])

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
    if (!snapshot?.modelPath) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      return
    }

    const refreshSnapshot = async () => {
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
    }

    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
    }

    pollTimerRef.current = window.setInterval(() => {
      void refreshSnapshot()
    }, pollIntervalMs)

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [pollIntervalMs, snapshot?.modelPath, t.pollingFailed])

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
    const nextSnapshot = await withBusyState(
      () => api.loadModel({ modelName, source }),
      (loadedSnapshot) => {
        setSnapshot(loadedSnapshot)
        setStatus(loadedSnapshot.status)
        setSuccessMessage(`${t.loaded} ${formatModelPath(loadedSnapshot.modelPath)}`)
      },
    )

    if (nextSnapshot?.modelPath) {
      void loadGeneratedSources()
    }
  }

  async function handleSourceFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const nextModelName = deriveModelName(file.name)

      setSource(text)
      setModelName(nextModelName)

      const nextSnapshot = await withBusyState(
        () => api.loadModel({ modelName: nextModelName, source: text }),
        (loadedSnapshot) => {
          setSnapshot(loadedSnapshot)
          setStatus(loadedSnapshot.status)
          setSuccessMessage(`${t.fileLoaded}: ${file.name}`)
        },
      )

      if (nextSnapshot?.modelPath) {
        void loadGeneratedSources()
      }
    } catch {
      setError(t.fileLoadFailed)
    } finally {
      event.target.value = ''
    }
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

  const lifecyclePrimary = useMemo(() => {
    if (!snapshot) return null

    if (status === 'RUNNING') {
      return {
        label: t.pause,
        icon: '\u23F8',
        message: t.simulationPaused,
        action: () => api.pause(),
      }
    }

    if (status === 'PAUSED') {
      return {
        label: t.resume,
        icon: '\u25B6',
        message: t.simulationResumed,
        action: () => api.resume(),
      }
    }

    return {
      label: t.start,
      icon: '\u25B6',
      message: t.simulationStarted,
      action: () => api.start(),
    }
  }, [
    snapshot,
    status,
    t.pause,
    t.resume,
    t.start,
    t.simulationPaused,
    t.simulationResumed,
    t.simulationStarted,
  ])

  const floatingAction = useMemo(() => {
    if (!lifecyclePrimary) return null

    return {
      label: lifecyclePrimary.label,
      icon: lifecyclePrimary.icon,
      onClick: () => void handleLifecycleAction(lifecyclePrimary.action, lifecyclePrimary.message),
    }
  }, [lifecyclePrimary])

  const editorTheme = theme === 'dark' ? 'vs-dark' : 'light'

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
              {theme === 'dark' ? '\u2600' : '\u263E'}
            </button>
          </div>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="panel editor-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">{editorViewMode === 'post' ? t.modelSource : editorTabLabels.generated}</p>
            </div>
            <span className="pill">
              {editorViewMode === 'post'
                ? `${source.length.toLocaleString()} ${t.chars}`
                : `${generatedSourceFileNames.length} ${editorTabLabels.filesWord}`}
            </span>
          </header>

          <div className="editor-mode-tabs" role="tablist" aria-label="Editor mode tabs">
            <button
              type="button"
              className={`editor-mode-tab ${editorViewMode === 'post' ? 'is-active' : ''}`}
              onClick={() => setEditorViewMode('post')}
            >
              {editorTabLabels.post}
            </button>
            <button
              type="button"
              className={`editor-mode-tab ${editorViewMode === 'java' ? 'is-active' : ''}`}
              onClick={() => setEditorViewMode('java')}
            >
              {editorTabLabels.java}
            </button>
          </div>

          {editorViewMode === 'post' ? (
            <>
              <div className="editor-toolbar">
                <label className="field">
                  <span>{t.modelName}</span>
                  <input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="traffic" />
                </label>
              </div>

              <div className="source-editor monaco-editor-shell">
                <Editor
                  height="100%"
                  defaultLanguage="plaintext"
                  language="plaintext"
                  theme={editorTheme}
                  value={source}
                  onChange={(value) => setSource(value ?? '')}
                  options={{
                    automaticLayout: true,
                    fontSize: 14,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    wordWrap: 'on',
                  }}
                />
              </div>

              <div className="editor-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".post,.txt,text/plain"
                  hidden
                  onChange={(event) => void handleSourceFilePicked(event)}
                />
                <button className="primary-button" disabled={isBusy} onClick={() => void handleLoadModel()}>
                  {t.loadModel}
                </button>
                <button
                  className="ghost-button file-trigger-button"
                  type="button"
                  disabled={isBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="button-icon" aria-hidden="true">
                    {'\uD83D\uDCC2'}
                  </span>
                  <span>{t.loadFromFile}</span>
                </button>
              </div>
            </>
          ) : (
            <div className="generated-code-shell">
              <div className="generated-code-header">
                <div className="generated-file-tabs" role="tablist" aria-label="Generated Java files">
                  {generatedSourceFileNames.map((fileName) => (
                    <button
                      key={fileName}
                      type="button"
                      className={`generated-file-tab ${activeJavaFile === fileName ? 'is-active' : ''}`}
                      onClick={() => setActiveJavaFile(fileName)}
                    >
                      {fileName}
                    </button>
                  ))}
                </div>
              </div>

              {isGeneratedSourcesLoading ? (
                <div className="generated-empty-state">{t.syncing}</div>
              ) : generatedSourceFileNames.length === 0 ? (
                <div className="generated-empty-state">
                  {snapshot?.modelPath ? editorTabLabels.javaMissing : editorTabLabels.javaEmpty}
                </div>
              ) : (
                <div className="source-editor generated-code-view monaco-editor-shell">
                  <Editor
                    height="100%"
                    defaultLanguage="java"
                    language="java"
                    theme={editorTheme}
                    value={activeJavaSource}
                    options={{
                      automaticLayout: true,
                      domReadOnly: true,
                      fontSize: 14,
                      minimap: { enabled: false },
                      readOnly: true,
                      scrollBeyondLastLine: false,
                      wordWrap: 'off',
                    }}
                  />
                </div>
              )}
            </div>
          )}
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
                disabled={isBusy || !lifecyclePrimary}
                onClick={() =>
                  lifecyclePrimary &&
                  void handleLifecycleAction(lifecyclePrimary.action, lifecyclePrimary.message)
                }
              >
                {lifecyclePrimary?.label ?? t.start}
              </button>
              <button
                className="ghost-button"
                disabled={isBusy || !snapshot}
                onClick={() => void handleLifecycleAction(() => api.stop(), t.simulationStopped)}
              >
                {t.stop}
              </button>
              <button
                className="ghost-button control-wide"
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
            {'\u25A0'}
          </button>

          <button
            className="floating-tool"
            type="button"
            onClick={() => void handleLifecycleAction(() => api.step(), t.singleStepExecuted)}
            disabled={isBusy || !snapshot}
            title={t.singleStep}
            aria-label={t.singleStep}
          >
            {'\u2192'}
          </button>

          <button
            className="floating-tool"
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            title="Up"
            aria-label="Up"
          >
            {'\u2191'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default App
