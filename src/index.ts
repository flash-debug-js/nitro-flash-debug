import type { HTTPEvent } from 'h3'
import { getEventContext, getRequestURL } from 'h3'
import { definePlugin } from 'nitro'

export type NitroFlashDebugLevel = 'debug' | 'info' | 'warning' | 'error'

export interface NitroFlashDebugLogInput {
  level: NitroFlashDebugLevel
  message: string
  type?: string
  content?: string
  contentFormat?: string
  tag?: string
  attributes?: Record<string, unknown>
  error?: unknown
  stackTrace?: string
}

export interface NitroFlashDebugLogger {
  log: (input: NitroFlashDebugLogInput) => unknown
  flush: () => Promise<void>
  close: () => Promise<void>
}

export interface NitroFlashDebugRequestState {
  startedAt: number
  method: string
  path: string
  traceId: string
  errorLogged?: boolean
}

export interface NitroFlashDebugPluginOptions {
  logger: NitroFlashDebugLogger
  source?: string
  includeSuccessfulResponses?: boolean
  slowRequestMs?: number
  ignoredPaths?: readonly string[]
  getRequestAttributes?: (event: HTTPEvent, state: NitroFlashDebugRequestState) => Record<string, unknown>
  onError?: (error: unknown) => void
}

interface NormalizedNitroFlashDebugOptions {
  logger: NitroFlashDebugLogger
  source: string
  includeSuccessfulResponses: boolean
  slowRequestMs: number
  ignoredPaths: ReadonlySet<string>
  getRequestAttributes?: (event: HTTPEvent, state: NitroFlashDebugRequestState) => Record<string, unknown>
  onError?: (error: unknown) => void
}

export const NITRO_FLASH_DEBUG_CONTEXT_KEY = '__nitroFlashDebug' as const
export const NITRO_FLASH_DEBUG_LOGGER_CONTEXT_KEY = '__nitroFlashDebugLogger' as const

const DEFAULT_SOURCE = 'server'
const DEFAULT_SLOW_REQUEST_MS = 1_000

export function createNitroFlashDebugPlugin(options: NitroFlashDebugPluginOptions) {
  const configuration = normalizeOptions(options)

  return definePlugin((nitro) => {
    nitro.hooks.hook('request', (event) => {
      const state = createRequestState(event)
      const context = getEventContext<Record<string, unknown>>(asH3Event(event))
      context[NITRO_FLASH_DEBUG_CONTEXT_KEY] = state
      context[NITRO_FLASH_DEBUG_LOGGER_CONTEXT_KEY] = configuration.logger
    })

    nitro.hooks.hook('response', (response, event) => {
      const state = getRequestState(event)
      if (!state || configuration.ignoredPaths.has(state.path)) {
        return
      }

      const status = response.status || responseStatus(event)
      const durationMs = Math.max(0, Date.now() - state.startedAt)
      const shouldLog = configuration.includeSuccessfulResponses
        || status >= 400
        || durationMs >= configuration.slowRequestMs
      if (!shouldLog || state.errorLogged) {
        return
      }

      emitRequestLog(configuration, event, state, status, durationMs)
    })

    nitro.hooks.hook('error', (error, context) => {
      const event = context.event
      if (!event) {
        emitErrorLog(configuration, undefined, undefined, error)
        return
      }

      const state = getRequestState(event)
      if (state) {
        state.errorLogged = true
      }
      emitErrorLog(configuration, event, state, error)
    })

    nitro.hooks.hook('close', async () => {
      try {
        await configuration.logger.close()
      }
      catch (error) {
        configuration.onError?.(error)
      }
    })
  })
}

export function getNitroFlashDebugLogger(event: HTTPEvent): NitroFlashDebugLogger | undefined {
  const context = getEventContext<Record<string, unknown>>(event)
  const logger = context[NITRO_FLASH_DEBUG_LOGGER_CONTEXT_KEY]
  return isLogger(logger)
    ? logger
    : undefined
}

export function requireNitroFlashDebugLogger(event: HTTPEvent): NitroFlashDebugLogger {
  const logger = getNitroFlashDebugLogger(event)
  if (!logger) {
    throw new Error('Nitro Flash Debug logger is not registered for this request')
  }
  return logger
}

export function getNitroFlashDebugRequestState(event: HTTPEvent): NitroFlashDebugRequestState | undefined {
  return getRequestState(event)
}

function normalizeOptions(options: NitroFlashDebugPluginOptions): NormalizedNitroFlashDebugOptions {
  if (!isLogger(options.logger)) {
    throw new Error('Nitro Flash Debug plugin requires a logger')
  }

  return {
    logger: options.logger,
    source: options.source?.trim() || DEFAULT_SOURCE,
    includeSuccessfulResponses: options.includeSuccessfulResponses ?? false,
    slowRequestMs: positiveNumber(options.slowRequestMs, DEFAULT_SLOW_REQUEST_MS),
    ignoredPaths: new Set(options.ignoredPaths ?? ['/healthz']),
    getRequestAttributes: options.getRequestAttributes,
    onError: options.onError,
  }
}

function createRequestState(event: HTTPEvent): NitroFlashDebugRequestState {
  const url = requestUrl(event)
  return {
    startedAt: Date.now(),
    method: event.req.method || 'GET',
    path: url.pathname,
    traceId: event.req.headers.get('x-trace-id')?.trim() || createTraceId(),
  }
}

function getRequestState(event: HTTPEvent): NitroFlashDebugRequestState | undefined {
  const context = getEventContext<Record<string, unknown>>(asH3Event(event))
  const state = context[NITRO_FLASH_DEBUG_CONTEXT_KEY]
  return isRequestState(state)
    ? state
    : undefined
}

function emitRequestLog(
  options: ReturnType<typeof normalizeOptions>,
  event: HTTPEvent,
  state: NitroFlashDebugRequestState,
  status: number,
  durationMs: number,
): void {
  const attributes = {
    ...options.getRequestAttributes?.(event, state),
    traceId: state.traceId,
    method: state.method,
    path: state.path,
    status,
    durationMs,
    source: options.source,
  }
  const level = status >= 500
    ? 'error'
    : status >= 400 || durationMs >= options.slowRequestMs
      ? 'warning'
      : 'info'

  emitLog(options, {
    level,
    type: 'http',
    message: `${state.method} ${state.path} ${status}`,
    attributes,
  })
}

function emitErrorLog(
  options: ReturnType<typeof normalizeOptions>,
  event: HTTPEvent | undefined,
  state: NitroFlashDebugRequestState | undefined,
  error: unknown,
): void {
  const attributes: Record<string, unknown> = {
    source: options.source,
    ...(state
      ? {
          traceId: state.traceId,
          method: state.method,
          path: state.path,
          durationMs: Math.max(0, Date.now() - state.startedAt),
        }
      : {}),
  }
  if (event) {
    attributes.status = responseStatus(event)
  }

  emitLog(options, {
    level: 'error',
    type: 'exception',
    message: errorMessage(error),
    error,
    attributes,
  })
}

function emitLog(
  options: NormalizedNitroFlashDebugOptions,
  input: NitroFlashDebugLogInput,
): void {
  try {
    options.logger.log(input)
  }
  catch (error) {
    options.onError?.(error)
  }
}

function isLogger(value: unknown): value is NitroFlashDebugLogger {
  return typeof value === 'object'
    && value !== null
    && typeof (value as NitroFlashDebugLogger).log === 'function'
    && typeof (value as NitroFlashDebugLogger).flush === 'function'
    && typeof (value as NitroFlashDebugLogger).close === 'function'
}

function isRequestState(value: unknown): value is NitroFlashDebugRequestState {
  return typeof value === 'object'
    && value !== null
    && typeof (value as NitroFlashDebugRequestState).startedAt === 'number'
    && typeof (value as NitroFlashDebugRequestState).method === 'string'
    && typeof (value as NitroFlashDebugRequestState).path === 'string'
    && typeof (value as NitroFlashDebugRequestState).traceId === 'string'
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

function createTraceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto)
  }
  return `fd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : fallback
}

function requestUrl(event: HTTPEvent): URL {
  try {
    return getRequestURL(asH3Event(event))
  }
  catch {
    return new URL(event.req.url, 'http://nitro.local')
  }
}

function responseStatus(event: HTTPEvent): number {
  const response = (event as unknown as { res?: { status?: number } }).res
  return response?.status ?? 500
}

function asH3Event(event: HTTPEvent): Parameters<typeof getEventContext>[0] {
  return event as Parameters<typeof getEventContext>[0]
}
