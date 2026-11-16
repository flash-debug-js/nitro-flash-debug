import type { HTTPEvent } from 'h3'
import { describe, expect, it } from 'vitest'
import {
  createNitroFlashDebugPlugin,
  getNitroFlashDebugLogger,
  getNitroFlashDebugRequestState,
} from '../src'

function createLogger() {
  const records: unknown[] = []
  return {
    records,
    logger: {
      log(input: unknown) {
        records.push(input)
      },
      async flush() {},
      async close() {},
    },
  }
}

function createEvent(path = '/api/test') {
  const event = {
    req: {
      method: 'GET',
      url: `http://localhost${path}`,
      headers: new Headers({ 'x-trace-id': 'trace-test' }),
    },
    res: {
      status: 200,
      headers: new Headers(),
    },
    context: {},
  } as unknown as HTTPEvent
  return event
}

describe('nitro flash debug plugin', () => {
  it('logs failed responses and exposes the logger on the event context', async () => {
    const { logger, records } = createLogger()
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const plugin = createNitroFlashDebugPlugin({ logger })
    await plugin({
      hooks: {
        hook(name: string, handler: (...args: any[]) => unknown) {
          handlers.set(name, handler)
        },
      },
    } as any)

    const event = createEvent()
    await handlers.get('request')?.(event)
    expect(getNitroFlashDebugLogger(event)).toBe(logger)
    expect(getNitroFlashDebugRequestState(event)?.traceId).toBe('trace-test')

    await handlers.get('response')?.({ status: 500 }, event)

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'error',
      type: 'http',
      message: 'GET /api/test 500',
      attributes: {
        traceId: 'trace-test',
        status: 500,
      },
    })
  })

  it('ignores health checks and flushes the logger on Nitro close', async () => {
    const { logger, records } = createLogger()
    let closed = 0
    logger.close = async () => {
      closed += 1
    }
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const plugin = createNitroFlashDebugPlugin({ logger })
    await plugin({
      hooks: {
        hook(name: string, handler: (...args: any[]) => unknown) {
          handlers.set(name, handler)
        },
      },
    } as any)

    const event = createEvent('/healthz')
    await handlers.get('request')?.(event)
    await handlers.get('response')?.({ status: 500 }, event)
    await handlers.get('close')?.()

    expect(records).toHaveLength(0)
    expect(closed).toBe(1)
  })
})
