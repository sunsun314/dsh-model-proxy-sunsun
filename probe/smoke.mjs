/**
 * Standalone smoke test for dsh-model-proxy.
 *
 * Boots the plugin against a stub Cordis context and drives real requests
 * through the installed global dispatcher, asserting which route each one took.
 * The API key is read from the DSH credential store; the proxy endpoint must be
 * the one the deployment config names.
 *
 * Usage: node probe/smoke.mjs [--proxy-down]
 *
 * @module dsh-model-proxy/probe/smoke
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher } from 'undici'

import { apply } from '../index.js'

const PROXY_DOWN = process.argv.includes('--proxy-down')
const OPENCODE_ORIGIN = 'https://opencode.ai/zen/go/v1'

/** Read the deployment's OpenCode Go key out of the DSH credential store. */
function readApiKey() {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  const match = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(file, 'utf8'))
  if (match === null) throw new Error('OPENCODE_API_KEY is not present in the DSH credential store')
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

/** Assert one request took the expected route and returned a usable status. */
function check(name, condition, detail) {
  const verdict = condition ? 'PASS' : 'FAIL'
  console.log(`${verdict}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

const apiKey = readApiKey()
console.log(`pre-install dispatcher: ${getGlobalDispatcher()?.constructor?.name ?? 'unknown'}`)
const stub = createStubContext()
await apply(stub.ctx, {
  enabled: true,
  proxy: PROXY_DOWN ? 'http://127.0.0.1:9' : 'http://127.0.0.1:10793',
  origins: ['opencode.ai'],
  models: ['grok-*', 'gpt-*-luna'],
  fallbackToDirect: true,
  probeTimeoutMs: 300,
  probeCacheMs: 50,
  peekBytes: 16384,
})

// The Go gateway refuses any request without this header, so a request that
// arrives intact always answers with a status rather than a transport error.
const headers = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
  'x-opencode-session': 'model-proxy-smoke',
}

const catalog = await fetch(`${OPENCODE_ORIGIN}/models`, { headers })
const catalogJson = await catalog.json().catch(() => undefined)
check('catalog GET answers with intact JSON', catalog.ok && Array.isArray(catalogJson?.data), `HTTP ${catalog.status} models=${catalogJson?.data?.length ?? 'unparsed'}`)

const other = await fetch(`${OPENCODE_ORIGIN}/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
})
const otherJson = await other.json().catch(() => undefined)
check('non-matching model answers with intact JSON', other.ok && typeof otherJson?.choices?.[0]?.message?.content === 'string', `HTTP ${other.status}`)

const grok = await fetch(`${OPENCODE_ORIGIN}/responses`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model: 'grok-4.7', input: 'say hi', store: false, max_output_tokens: 16 }),
})
const grokJson = await grok.json().catch(() => undefined)
if (PROXY_DOWN) {
  // Direct from here is geo-blocked, so an answered request proves the request
  // still reached the gateway with its body intact.
  check('matching model still reaches the gateway while the proxy is down', grok.status === 403 && typeof grokJson?.error?.message === 'string', `HTTP ${grok.status} ${grokJson?.error?.message ?? 'unparsed'}`)
} else {
  check('matching model answers through the proxy', grok.ok && grokJson?.output?.[1]?.content?.[0]?.text !== undefined, `HTTP ${grok.status} ${grokJson?.output?.[1]?.content?.[0]?.text ?? grokJson?.error?.message ?? 'unparsed'}`)
}

const routes = stub.lines.filter(line => line.includes('route='))
console.log('\n--- decisions ---')
for (const line of stub.lines) console.log(line)
console.log('--- end ---\n')

check('catalog route is direct', routes.some(line => line.includes('reason=origin')), 'GET/HEAD has no model body')
if (PROXY_DOWN) {
  // A stopped proxy short-circuits before the body is inspected, so both POSTs
  // report the fallback rather than the model they carry.
  check('stopped proxy falls back to direct', routes.filter(line => line.includes('reason=proxy-down')).length === 2)
} else {
  check('non-matching model is direct', routes.some(line => line.includes('model-other:glm-5.3-flash')))
  check('matching model is proxied', routes.some(line => line.includes('route=proxy') && line.includes('model:grok-4.7')))
}

await stub.dispose()
check('dispose releases the route', !stub.lines.some(line => line.includes('release failed')))
