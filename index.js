/**
 * dsh-model-proxy — send the models you name through an outbound proxy, and
 * fall back to a direct connection whenever that proxy is not accepting
 * connections.
 *
 * DSH, pi-ai, and the provider SDKs all issue requests through
 * `globalThis.fetch`, which resolves undici's well-known global dispatcher slot
 * (`Symbol.for('undici.globalDispatcher.1')`). This plugin owns that slot and
 * forwards each request to one of two routes:
 *
 * - a request whose JSON body names a model matching `models` goes through
 *   `proxy`;
 * - every other request keeps the route that was installed before this plugin
 *   loaded, so a deployment without proxy environment variables stays direct.
 *
 * `fallbackToDirect` keeps a stopped proxy from taking the whole provider down:
 * while the proxy's host:port refuses connections, matching requests use the
 * pre-existing route too.
 *
 * @module dsh-model-proxy
 */

import net from 'node:net'

/** Cordis plugin name. */
export const name = 'model-proxy'

/** Deployment defaults for {@link resolveConfig}. */
const DEFAULT_CONFIG = {
  enabled: true,
  proxy: 'http://127.0.0.1:10793',
  origins: ['opencode.ai'],
  models: ['grok-*', 'gpt-*-luna'],
  fallbackToDirect: true,
  probeTimeoutMs: 300,
  probeCacheMs: 2000,
  peekBytes: 16384,
}

/**
 * Validate and complete the deployment configuration.
 *
 * Every supplied value is checked here because a wrong one must fail the
 * activation instead of silently routing traffic to the wrong place.
 * @param raw - the row's `config` object, or undefined.
 * @returns the complete configuration, with `models` compiled to matchers.
 * @throws {TypeError} when a supplied field has the wrong type or an unusable value.
 */
function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (typeof config.enabled !== 'boolean') {
    throw new TypeError(`dsh-model-proxy: config.enabled must be a boolean, got ${JSON.stringify(config.enabled)}`)
  }
  if (typeof config.fallbackToDirect !== 'boolean') {
    throw new TypeError(`dsh-model-proxy: config.fallbackToDirect must be a boolean, got ${JSON.stringify(config.fallbackToDirect)}`)
  }
  const proxy = parseProxyUrl(config.proxy)
  const origins = requireStringArray(config.origins, 'origins')
  if (origins.length === 0) {
    throw new TypeError('dsh-model-proxy: config.origins must name at least one host')
  }
  const models = requireStringArray(config.models, 'models')
  if (models.length === 0) {
    throw new TypeError('dsh-model-proxy: config.models must name at least one model pattern')
  }
  for (const key of ['probeTimeoutMs', 'probeCacheMs', 'peekBytes']) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`dsh-model-proxy: config.${key} must be a positive safe integer, got ${JSON.stringify(value)}`)
    }
  }
  return {
    enabled: config.enabled,
    proxy,
    proxyUrl: config.proxy,
    origins: new Set(origins.map(host => host.toLowerCase())),
    modelMatchers: models.map(compileModelPattern),
    modelPatterns: models,
    fallbackToDirect: config.fallbackToDirect,
    probeTimeoutMs: config.probeTimeoutMs,
    probeCacheMs: config.probeCacheMs,
    peekBytes: config.peekBytes,
  }
}

/**
 * Parse the proxy URL and take the endpoint the health probe needs.
 * @param value - the configured proxy value.
 * @returns the proxy URL and its host and port.
 * @throws {TypeError} when the value is not an absolute http(s) URL.
 */
function parseProxyUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`dsh-model-proxy: config.proxy must be a non-empty URL string, got ${JSON.stringify(value)}`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`dsh-model-proxy: config.proxy "${value}" is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`dsh-model-proxy: config.proxy "${value}" must use http: or https:`)
  }
  const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { url: url.href, host: url.hostname, port }
}

/**
 * Read a configuration field that must be an array of non-empty strings.
 * @param value - the supplied value.
 * @param key - the field name, for the diagnostic.
 * @returns the copied array.
 * @throws {TypeError} when the value is not such an array.
 */
function requireStringArray(value, key) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError(`dsh-model-proxy: config.${key} must be an array of non-empty strings, got ${JSON.stringify(value)}`)
  }
  return [...value]
}

/**
 * Compile one model pattern. `*` matches any run of characters; every other
 * character matches itself.
 * @param pattern - the configured pattern.
 * @returns a predicate for one model identifier.
 */
function compileModelPattern(pattern) {
  const expression = pattern
    .split('*')
    .map(part => part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const matcher = new RegExp(`^${expression}$`)
  return model => matcher.test(model)
}

/**
 * Resolve the request's origin host.
 * @param options - the undici dispatch options.
 * @returns the lowercase host, or undefined when no origin is carried.
 */
function originHost(options) {
  const origin = options.origin
  if (origin === undefined || origin === null) return undefined
  try {
    const url = origin instanceof URL ? origin : new URL(String(origin))
    return url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * View one body chunk as bytes without changing what is forwarded.
 * @param chunk - one chunk from a request body.
 * @returns the chunk as a Buffer.
 */
function chunkToBuffer(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  return Buffer.from(String(chunk), 'utf8')
}

/**
 * Name the model a JSON request body asks for.
 * @param text - decoded body text, which may be a truncated prefix.
 * @returns the model identifier, or undefined when the prefix names none.
 */
function modelFromText(text) {
  // The length bound keeps a truncated prefix from matching a value whose
  // closing quote never arrived.
  const match = /"model"\s*:\s*"([^"\\]{1,200})"/.exec(text)
  return match?.[1]
}

/**
 * Read the head of a request body far enough to name its model, then hand the
 * whole body on unchanged.
 *
 * Only the first chunks are held, and the returned iterator yields the held
 * chunks before continuing with the original stream, so backpressure and chunk
 * boundaries survive.
 * @param body - the request body from the dispatch options.
 * @param limitBytes - how many bytes may be inspected before giving up.
 * @returns the model identifier when the head names one, and the body to forward.
 */
async function peekModel(body, limitBytes) {
  if (typeof body === 'string') return { model: modelFromText(body), body }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return { model: modelFromText(chunkToBuffer(body).toString('utf8')), body }
  }
  if (body === null || body === undefined || typeof body[Symbol.asyncIterator] !== 'function') {
    return { model: undefined, body }
  }
  const iterator = body[Symbol.asyncIterator]()
  const held = []
  let size = 0
  let exhausted = false
  let model
  while (size < limitBytes) {
    const step = await iterator.next()
    if (step.done === true) {
      exhausted = true
      break
    }
    held.push(step.value)
    size += chunkToBuffer(step.value).length
    model = modelFromText(Buffer.concat(held.map(chunkToBuffer)).toString('utf8'))
    if (model !== undefined) break
  }
  const replay = async function* replayBody() {
    for (const chunk of held) yield chunk
    if (exhausted) return
    for (;;) {
      const step = await iterator.next()
      if (step.done === true) return
      yield step.value
    }
  }
  return { model, body: replay() }
}

/**
 * Build a cached reachability check for the proxy endpoint.
 *
 * A stopped proxy client closes its local listening socket, so a refused or
 * timed-out TCP connect is what "the proxy is off" looks like from here. The
 * verdict is cached briefly because every matching request asks for it.
 * @param options - proxy endpoint and probe timings.
 * @returns a function resolving true while the endpoint accepts connections.
 */
function createProxyProbe(options) {
  let cached
  let expiresAt = 0
  return async function proxyIsListening() {
    const now = Date.now()
    if (cached !== undefined && now < expiresAt) return cached
    const listening = await new Promise(resolve => {
      const socket = net.connect({ host: options.host, port: options.port })
      const settle = (result) => {
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(options.timeoutMs)
      socket.once('connect', () => { settle(true) })
      socket.once('timeout', () => { settle(false) })
      socket.once('error', () => { settle(false) })
    })
    cached = listening
    expiresAt = Date.now() + options.cacheMs
    return listening
  }
}

/**
 * A dispatcher that routes by model name and forwards everything else.
 *
 * `dispatch` answers synchronously, as undici requires, and completes the route
 * decision asynchronously because naming the model means reading the request
 * body's head. Both routes are ordinary dispatchers that receive the caller's
 * handler unchanged.
 * @param options - the routes, the matchers, and the decision diagnostics.
 * @returns the installed dispatcher.
 */
function createRoutingDispatcher(options) {
  const { Dispatcher } = options.undici

  class ModelRoutingDispatcher extends Dispatcher {
    #closed = false

    dispatch(dispatchOptions, handler) {
      void this.#route(dispatchOptions, handler)
      return true
    }

    /**
     * Choose a route for one request and hand the request to it.
     * @param dispatchOptions - the undici dispatch options.
     * @param handler - the caller's handler, forwarded unchanged.
     */
    async #route(dispatchOptions, handler) {
      let target = options.direct
      let reason = 'origin'
      try {
        const host = originHost(dispatchOptions)
        if (host !== undefined && options.config.origins.has(host) && hasRequestBody(dispatchOptions)) {
          const listening = await options.proxyIsListening()
          if (!listening) {
            reason = 'proxy-down'
          } else {
            const peeked = await peekModel(dispatchOptions.body, options.config.peekBytes)
            dispatchOptions.body = peeked.body
            if (peeked.model === undefined) {
              reason = 'no-model'
            } else if (options.config.modelMatchers.some(matches => matches(peeked.model))) {
              target = options.proxied
              reason = `model:${peeked.model}`
            } else {
              reason = `model-other:${peeked.model}`
            }
          }
        }
      } catch (error) {
        options.report(`route fell back to direct after ${describeError(error)}`)
      }
      options.record(target === options.proxied ? 'proxy' : 'direct', reason)
      target.dispatch(dispatchOptions, handler)
    }

    close() {
      return this.#closed ? Promise.resolve() : (this.#closed = true, options.closeRoutes())
    }

    destroy() {
      return this.close()
    }
  }

  return new ModelRoutingDispatcher()
}

/**
 * Whether the request carries a body whose head can name a model.
 * @param options - the undici dispatch options.
 * @returns true for a method and body that a model name can be read from.
 */
function hasRequestBody(options) {
  return options.body !== null && options.body !== undefined && options.method !== 'GET' && options.method !== 'HEAD'
}

/**
 * Render one error for a diagnostic line.
 * @param error - the caught value.
 * @returns the message, or the stringified value.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Install the routing dispatcher for this process.
 *
 * Asynchronous so the undici import resolves before the slot is claimed; the
 * Loader rolls the activation back when this rejects.
 * @param ctx - the plugin context, used for its logger and effect scope.
 * @param raw - the row's configuration object.
 */
export async function apply(ctx, raw) {
  const config = resolveConfig(raw)
  if (!config.enabled) {
    ctx.logger.info('dsh-model-proxy: disabled by configuration; every request keeps its route')
    return
  }
  const undici = await import('undici')
  const direct = undici.getGlobalDispatcher()
  const proxied = new undici.ProxyAgent({ uri: config.proxyUrl, proxyTunnel: true })
  const proxyIsListening = createProxyProbe({
    host: config.proxy.host,
    port: config.proxy.port,
    timeoutMs: config.probeTimeoutMs,
    cacheMs: config.probeCacheMs,
  })
  let lastReason
  const record = (route, reason) => {
    const line = `dsh-model-proxy: route=${route} via=${route === 'proxy' ? config.proxyUrl : 'direct'} reason=${reason}`
    if (route === 'proxy' || reason !== lastReason) ctx.logger.info(line)
    else ctx.logger.debug?.(line)
    lastReason = reason
  }
  const dispatcher = createRoutingDispatcher({
    undici,
    config,
    direct,
    proxied,
    proxyIsListening,
    record,
    report: message => { ctx.logger.warn(`dsh-model-proxy: ${message}`) },
    closeRoutes: () => Promise.allSettled([proxied.close()]).then(() => undefined),
  })
  undici.setGlobalDispatcher(dispatcher)
  ctx.effect(() => () => {
    // An unloaded plugin must not keep owning the slot: another loader pass or
    // a later plugin has to be able to install its own route.
    if (undici.getGlobalDispatcher() === dispatcher) undici.setGlobalDispatcher(direct)
    return dispatcher.close()
  })
  ctx.logger.info(`dsh-model-proxy: models ${config.modelPatterns.join(', ')} on ${[...config.origins].join(', ')} via ${config.proxyUrl}${config.fallbackToDirect ? ', direct while it is down' : ''}`)
}
