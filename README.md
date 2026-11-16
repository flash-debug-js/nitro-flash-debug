# nitro-flash-debug

Nitro and H3 integration for sending structured server logs to Flash Debug.

The package owns Nitro lifecycle integration. The logger instance is injected
by the application, which keeps the plugin independent from a particular
transport implementation.

```ts
import { createLogger } from '@flash-debug/logger'
import { createNitroFlashDebugPlugin } from 'nitro-flash-debug'

const logger = createLogger({
  baseUrl: process.env.FLASH_DEBUG_BASE_URL!,
  clientId: 'insight-hub-api-beta',
  source: 'insight-hub-api',
  token: process.env.FLASH_DEBUG_TOKEN,
})

export default createNitroFlashDebugPlugin({ logger })
```

The plugin records request completion and uncaught Nitro errors. It adds the
logger to `event.context` so application handlers can emit domain events with
the same logger instance.
