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
 * - a request whose URL path or JSON body names a model matching `models` goes
 *   through `proxy`;
 * - every other request keeps the route that was installed before this plugin
 *   loaded, so a deployment without proxy environment variables stays direct.
 *
 * `fallbackToDirect` keeps a stopped proxy from taking the whole provider down:
 * while the proxy's host:port refuses connections, matching requests use the
 * pre-existing route too.
 *
 * `rateLimit` paces the proxied requests, so an upstream that allows only a few
 * requests per second is never asked for more than that. The wait happens before
 * the request is dispatched, so a caller sees a slower response rather than a
 * rejection; a request that would wait past `maxWaitMs` fails instead of being
 * sent, and never falls back to the direct route, which is the very traffic the
 * limit exists to hold back.
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
  rateLimit: {
    enabled: false,
    requestsPerSecond: 1,
    burst: 1,
    scope: 'model',
    models: [],
    maxWaitMs: 120000,
  },
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
    rateLimit: resolveRateLimit(config.rateLimit),
  }
}

/**
 * Validate the `rateLimit` block.
 *
 * The block resolves even when pacing is off, so the dispatcher can ask one place
 * whether a matched model is paced.
 * @param raw - the row's `config.rateLimit`, or undefined.
 * @returns the resolved block, with the paced-model patterns compiled.
 * @throws {TypeError} when a supplied field has the wrong type or an unusable value.
 */
function resolveRateLimit(raw) {
  const rateLimit = { ...DEFAULT_CONFIG.rateLimit, ...(raw ?? {}) }
  if (typeof rateLimit.enabled !== 'boolean') {
    throw new TypeError(`dsh-model-proxy: config.rateLimit.enabled must be a boolean, got ${JSON.stringify(rateLimit.enabled)}`)
  }
  if (typeof rateLimit.requestsPerSecond !== 'number' || !Number.isFinite(rateLimit.requestsPerSecond) || rateLimit.requestsPerSecond <= 0) {
    throw new TypeError(`dsh-model-proxy: config.rateLimit.requestsPerSecond must be a positive finite number, got ${JSON.stringify(rateLimit.requestsPerSecond)}`)
  }
  if (!Number.isSafeInteger(rateLimit.burst) || rateLimit.burst <= 0) {
    throw new TypeError(`dsh-model-proxy: config.rateLimit.burst must be a positive safe integer, got ${JSON.stringify(rateLimit.burst)}`)
  }
  if (rateLimit.scope !== 'model' && rateLimit.scope !== 'shared') {
    throw new TypeError(`dsh-model-proxy: config.rateLimit.scope must be "model" or "shared", got ${JSON.stringify(rateLimit.scope)}`)
  }
  if (!Number.isSafeInteger(rateLimit.maxWaitMs) || rateLimit.maxWaitMs < 0) {
    throw new TypeError(`dsh-model-proxy: config.rateLimit.maxWaitMs must be a non-negative safe integer, got ${JSON.stringify(rateLimit.maxWaitMs)}`)
  }
  const pacedModels = requireStringArray(rateLimit.models, 'rateLimit.models')
  return {
    enabled: rateLimit.enabled,
    requestsPerSecond: rateLimit.requestsPerSecond,
    burst: rateLimit.burst,
    scope: rateLimit.scope,
    maxWaitMs: rateLimit.maxWaitMs,
    pacedPatterns: pacedModels,
    pacedMatchers: pacedModels.map(compileModelPattern),
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
 * Name the model a request path asks for.
 *
 * The native Google APIs name their model in the path and leave it out of the
 * JSON body entirely, so a body-only matcher never sees it: Google Generative AI
 * posts to `/v1beta/models/<model>:streamGenerateContent`, and Vertex to
 * `/v1/projects/<project>/locations/<location>/publishers/google/models/<model>:generateContent`.
 * Both spellings, plus `tunedModels/<model>`, are read here.
 *
 * A collection path such as `/v1beta/models?pageSize=10` names no model: the
 * `models` segment has to be followed by a separator and a name.
 * @param path - the request path from the undici dispatch options, query included.
 * @returns the model identifier, or undefined when the path names none.
 */
export function modelFromPath(path) {
  if (typeof path !== 'string') return undefined
  // The length bound keeps a pathological segment from being offered as a model.
  const match = /\/(?:tunedModels|models)\/([^/:?]{1,200})/.exec(path)
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
 * Raised when a request would have to wait past `rateLimit.maxWaitMs`.
 *
 * The request is not sent at all: sending it would spend the upstream quota the
 * limit protects, and falling back to the direct route would spend it even
 * faster.
 */
export class RateLimitExceededError extends Error {
  /**
   * @param key - the bucket the request belonged to.
   * @param waitedMs - how long this request had already waited.
   * @param maxWaitMs - the configured ceiling.
   */
  constructor(key, waitedMs, maxWaitMs) {
    super(`dsh-model-proxy: rate limit for ${key} would wait past ${maxWaitMs}ms (already waited ${waitedMs}ms); the request was not sent`)
    this.name = 'RateLimitExceededError'
    this.key = key
    this.waitedMs = waitedMs
    this.maxWaitMs = maxWaitMs
  }
}

/**
 * Build the pacing limiter.
 *
 * One token bucket per key, refilled at `requestsPerSecond` with `burst` tokens
 * of capacity, so a short idle period banks a small burst instead of wasting it.
 * Acquisitions on one key run in arrival order because each waits on the previous
 * one's turn; an acquisition that is refused does not stall the ones behind it.
 * @param options - the resolved `rateLimit` block.
 * @returns a limiter whose `acquire` resolves with the milliseconds it waited.
 */
export function createRateLimiter(options) {
  const tokensPerMs = options.requestsPerSecond / 1000
  const buckets = new Map()

  // The timer stays referenced on purpose: a request waiting for its slot is
  // outstanding work, and letting the event loop drain under it would lose the
  // call before it was ever dispatched.
  const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

  /**
   * Drain one token, waiting for it if the bucket is empty.
   * @param bucket - this key's bucket.
   * @param key - the bucket name, for the refusal diagnostic.
   * @returns the milliseconds this request waited.
   * @throws {RateLimitExceededError} when the wait would exceed `maxWaitMs`.
   */
  async function take(bucket, key) {
    let waitedMs = 0
    for (;;) {
      const now = Date.now()
      const elapsedMs = now - bucket.updatedAt
      if (elapsedMs > 0) {
        bucket.tokens = Math.min(options.burst, bucket.tokens + elapsedMs * tokensPerMs)
        bucket.updatedAt = now
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return waitedMs
      }
      const waitMs = Math.max(1, Math.ceil((1 - bucket.tokens) / tokensPerMs))
      if (waitedMs + waitMs > options.maxWaitMs) {
        throw new RateLimitExceededError(key, waitedMs, options.maxWaitMs)
      }
      await sleep(waitMs)
      waitedMs += waitMs
    }
  }

  return {
    /**
     * Reserve one slot in `key`'s bucket.
     * @param key - the bucket name: a model id, or `all` under shared scope.
     * @returns the milliseconds this request had to wait.
     */
    acquire(key) {
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { tokens: options.burst, updatedAt: Date.now(), queue: Promise.resolve() }
        buckets.set(key, bucket)
      }
      const turn = bucket.queue.then(() => take(bucket, key))
      // Keep the chain alive after a refusal so the requests behind it still run.
      bucket.queue = turn.then(() => undefined, () => undefined)
      return turn
    },
  }
}

/**
 * Name the bucket a matched model is paced in.
 * @param rateLimit - the resolved `rateLimit` block.
 * @param model - the matched model id.
 * @returns the bucket key, or undefined when this model is not paced.
 */
function pacedKey(rateLimit, model) {
  if (!rateLimit.enabled) return undefined
  if (rateLimit.pacedMatchers.length > 0 && !rateLimit.pacedMatchers.some(matches => matches(model))) return undefined
  return rateLimit.scope === 'shared' ? 'all' : model
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
      // Nothing may escape this promise: `dispatch` answers synchronously and the
      // caller does not await it, so an escape would surface as an unhandled
      // rejection and take the whole process down.
      this.#route(dispatchOptions, handler).catch(error => {
        options.report(`dispatch failed: ${describeError(error)}`)
        failDispatch(handler, error)
      })
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
      let model
      try {
        const host = originHost(dispatchOptions)
        if (host !== undefined && options.config.origins.has(host) && hasRequestBody(dispatchOptions)) {
          const listening = await options.proxyIsListening()
          if (!listening) {
            reason = 'proxy-down'
          } else {
            // The path is checked first because a request that names its model
            // there is routed without its body being held at all; only a request
            // that names none falls back to reading the body's head.
            model = modelFromPath(dispatchOptions.path)
            if (model === undefined) {
              const peeked = await peekModel(dispatchOptions.body, options.config.peekBytes)
              dispatchOptions.body = peeked.body
              model = peeked.model
            }
            if (model === undefined) {
              reason = 'no-model'
            } else if (options.config.modelMatchers.some(matches => matches(model))) {
              target = options.proxied
              reason = `model:${model}`
            } else {
              reason = `model-other:${model}`
            }
          }
        }
      } catch (error) {
        options.report(`route fell back to direct after ${describeError(error)}`)
      }

      // Pacing runs after the route is chosen and outside the catch above: a
      // request the limiter refuses has to fail rather than fall back to the
      // direct route, which is exactly the traffic the limit exists to hold back.
      let waitedMs
      const key = target === options.proxied && model !== undefined ? pacedKey(options.config.rateLimit, model) : undefined
      if (key !== undefined) {
        try {
          waitedMs = await options.rateLimit.acquire(key)
        } catch (error) {
          options.report(`refused a request for ${key}: ${describeError(error)}`)
          failDispatch(handler, error)
          return
        }
      }

      options.record(
        target === options.proxied ? 'proxy' : 'direct',
        reason,
        waitedMs === undefined || waitedMs === 0 ? undefined : `waited=${waitedMs}ms`,
      )
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
 * Fail one dispatch that was never handed to a route.
 *
 * undici hands a custom dispatcher a `LegacyHandlerWrapper`, which speaks the
 * newer handler interface (`onResponseError`) instead of the legacy one
 * (`onError`). Both spellings are accepted here because either interface can
 * arrive depending on which undici built the caller.
 * @param handler - the handler from the dispatch options.
 * @param error - the failure to report to it.
 * @throws when the handler implements neither spelling.
 */
function failDispatch(handler, error) {
  if (typeof handler?.onResponseError === 'function') handler.onResponseError(undefined, error)
  else if (typeof handler?.onError === 'function') handler.onError(error)
  else throw error
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
  const record = (route, reason, note) => {
    const suffix = note === undefined ? '' : ` ${note}`
    const line = `dsh-model-proxy: route=${route} via=${route === 'proxy' ? config.proxyUrl : 'direct'} reason=${reason}${suffix}`
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
    rateLimit: createRateLimiter(config.rateLimit),
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
  ctx.logger.info(`dsh-model-proxy: models ${config.modelPatterns.join(', ')} on ${[...config.origins].join(', ')} via ${config.proxyUrl}${config.fallbackToDirect ? ', direct while it is down' : ''}${describePacing(config.rateLimit)}`)
}

/**
 * Render the pacing summary appended to the activation line.
 * @param rateLimit - the resolved `rateLimit` block.
 * @returns the summary, or an empty string when nothing is paced.
 */
function describePacing(rateLimit) {
  if (!rateLimit.enabled) return ''
  const paced = rateLimit.pacedPatterns.length > 0 ? rateLimit.pacedPatterns.join(', ') : 'every matched model'
  return `, paced at ${rateLimit.requestsPerSecond}/s (burst ${rateLimit.burst}, ${rateLimit.scope} scope, refusing past ${rateLimit.maxWaitMs}ms) on ${paced}`
}
