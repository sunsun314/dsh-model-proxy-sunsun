/**
 * Decoding matrix: does each global-dispatcher configuration return the response
 * body intact to Node's built-in fetch?
 *
 * Usage: node probe/decode-matrix.mjs <baseline|agent8|proxy8|wrapper8>
 *
 * @module dsh-model-proxy/probe/decode-matrix
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Agent, Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

const mode = process.argv[2] ?? 'baseline'
const url = 'https://opencode.ai/zen/go/v1/models'

if (mode === 'agent8') setGlobalDispatcher(new Agent())
if (mode === 'proxy8') setGlobalDispatcher(new ProxyAgent({ uri: 'http://127.0.0.1:10793', proxyTunnel: true }))
if (mode === 'wrapper8') {
  const previous = getGlobalDispatcher()
  class Wrapper extends Dispatcher {
    dispatch(options, handler) { return previous.dispatch(options, handler) }
  }
  setGlobalDispatcher(new Wrapper())
}

const response = await fetch(url, { headers: { 'x-opencode-session': 'decode-matrix' } })
const bytes = Buffer.from(await response.arrayBuffer())
let parses = false
try {
  JSON.parse(bytes.toString('utf8'))
  parses = true
} catch { /* reported below */ }
console.log(
  `${mode.padEnd(9)} status=${response.status} encoding=${response.headers.get('content-encoding')} bytes=${bytes.length} parses=${parses} head=${JSON.stringify(bytes.subarray(0, 70).toString('utf8'))}`,
)
