/**
 * Live probe for routing the native Google Generative AI API.
 *
 * These requests name their model in the URL path and carry no `model` field in
 * the JSON body, which a body-only matcher cannot see. This probe boots the
 * plugin against a stub Cordis context, drives real requests through the
 * installed global dispatcher, and asserts the route each one took.
 *
 * The end-to-end assertion uses `:countTokens` rather than `:generateContent`:
 * the Gemini generation endpoints are reasoning models whose time-to-first-byte
 * swings from one second to well over a minute, so a generation call would make
 * this probe flaky for reasons that have nothing to do with routing. Token
 * counting carries the same request shape — model in the path, absent from the
 * body — and answers in about a second.
 *
 * The API key is read from the DSH credential store; the endpoint must be the
 * one the deployment config names.
 *
 * Usage: node probe/gemini.mjs [--proxy=http://127.0.0.1:7890] [--model=gemini-3.6-flash]
 *
 * @module dsh-model-proxy/probe/gemini
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher } from 'undici'

import { apply } from '../index.js'

/** Read one `--name=value` argument, or fall back. */
function arg(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.find(value => value.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const PROXY = arg('proxy', 'http://127.0.0.1:7890')
// A model the deployment is expected to be able to call. Override it when the
// one below has been retired upstream.
const MODEL = arg('model', 'gemini-3.6-flash')
const OTHER_MODEL = 'not-a-gemini-model'
const ORIGIN = 'https://generativelanguage.googleapis.com/v1beta'

/** Read the deployment's Google API key out of the DSH credential store. */
function readApiKey() {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  const match = /GOOGLE_API_KEY:\s*(\S+)/.exec(readFileSync(file, 'utf8'))
  if (match === null) throw new Error('GOOGLE_API_KEY is not present in the DSH credential store')
  return match[1]
}

/** Build the stub context `apply` needs, capturing diagnostics and the disposer. */
function createStubContext() {
  const lines = []
  const disposers = []
  return {
    lines,
    ctx: {
      logger: {
        info: (line) => lines.push(`info ${line}`),
        warn: (line) => lines.push(`warn ${line}`),
        debug: (line) => lines.push(`debug ${line}`),
      },
      effect: (callback) => { disposers.push(callback()) },
    },
    dispose: async () => { for (const dispose of disposers.reverse()) await dispose() },
  }
}

/** Assert one condition, recording a failure without stopping the probe. */
function check(name, condition, detail) {
  const verdict = condition ? 'PASS' : 'FAIL'
  console.log(`${verdict}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

/**
 * Drive one request and report the outcome instead of throwing.
 *
 * A transport failure is a result here, not a crash: the routing decision has
 * already been recorded by the time the request reaches the wire, and that
 * decision is what this probe is about.
 * @param label - the request's name, for the transcript.
 * @param url - the absolute URL to call.
 * @param options - fetch options plus the `timeoutMs` for this request.
 * @returns the status, the parsed JSON when there is one, and the error.
 */
async function drive(label, url, { timeoutMs, ...init }) {
  const started = Date.now()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.json().catch(() => undefined)
    console.log(`  ${label}: HTTP ${response.status} in ${Date.now() - started}ms`)
    return { status: response.status, body, error: undefined }
  } catch (error) {
    console.log(`  ${label}: ${error.name} in ${Date.now() - started}ms`)
    return { status: undefined, body: undefined, error }
  }
}

const apiKey = readApiKey()
const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey }

console.log(`pre-install dispatcher: ${getGlobalDispatcher()?.constructor?.name ?? 'unknown'}`)
console.log(`proxy: ${PROXY}`)
console.log(`model: ${MODEL}`)

const stub = createStubContext()
await apply(stub.ctx, {
  enabled: true,
  proxy: PROXY,
  origins: ['generativelanguage.googleapis.com'],
  models: ['gemini-*'],
  fallbackToDirect: true,
  probeTimeoutMs: 300,
  probeCacheMs: 50,
  peekBytes: 16384,
})

const pathBody = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'say OK' }] }] })
const compatBody = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'say OK' }] })

console.log('\n--- requests ---')
// 1. The model lives in the path and is absent from the body — the shape that
//    the native Google SDK produces.
const native = await drive('path-named, matching model', `${ORIGIN}/models/${MODEL}:countTokens`, {
  method: 'POST',
  headers,
  body: pathBody,
  timeoutMs: 30000,
})
// 2. A path naming a model outside `models` keeps the direct route. That route is
//    unreachable from a blocked region, so the request is aborted as soon as the
//    decision has been recorded; the decision is the assertion.
await drive('path-named, non-matching model', `${ORIGIN}/models/${OTHER_MODEL}:countTokens`, {
  method: 'POST',
  headers,
  body: pathBody,
  timeoutMs: 1500,
})
// 3. A body-named model on the same origin still routes, which is the fallback
//    the OpenAI-compatible gateways rely on.
await drive('body-named, matching model', `${ORIGIN}/openai/chat/completions`, {
  method: 'POST',
  headers,
  body: compatBody,
  timeoutMs: 30000,
})

const routes = stub.lines.filter(line => line.includes('route='))
console.log('\n--- decisions ---')
for (const line of stub.lines) console.log(line)
console.log('--- end ---\n')

check(
  'path-named model answers through the proxy',
  native.status === 200 && typeof native.body?.totalTokens === 'number',
  native.status === 200 ? `totalTokens=${native.body.totalTokens}` : `HTTP ${native.status} ${native.body?.error?.message ?? native.error?.message ?? 'unparsed'}`,
)
check('path-named non-matching model is direct', routes.some(line => line.includes('route=direct') && line.includes(`reason=model-other:${OTHER_MODEL}`)))
// Both the path-named request and the body-named one name the same model, so the
// proxy decision has to appear twice: once from each reader.
const matched = routes.filter(line => line.includes('route=proxy') && line.includes(`reason=model:${MODEL}`))
check('path reader and body reader both matched', matched.length >= 2, `${matched.length} proxy decisions for ${MODEL}`)

await stub.dispose()
check('dispose releases the route', !stub.lines.some(line => line.includes('release failed')))
