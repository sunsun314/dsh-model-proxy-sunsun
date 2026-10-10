/**
 * Offline probe for the rate limiter.
 *
 * The limiter is pure timing logic over an injected clock-free token bucket, so
 * this probe needs no network, no proxy, and no credential. It runs real timers
 * and asserts on the waits each acquisition reported, with tolerances wide enough
 * to survive scheduler jitter.
 *
 * Usage: node probe/rate-limit.mjs
 *
 * @module dsh-model-proxy/probe/rate-limit
 */

import { createRateLimiter, RateLimitExceededError } from '../index.js'

/** Assert one reader result. */
function check(name, condition, detail) {
  const verdict = condition ? 'PASS' : 'FAIL'
  console.log(`${verdict}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

/** Time one acquisition, returning the reported wait and the observed one. */
async function acquire(limiter, key) {
  const started = Date.now()
  const reported = await limiter.acquire(key)
  return { reported, observed: Date.now() - started }
}

const INTERVAL = 40 // 25 requests per second

console.log('--- pacing: one slot per interval, in arrival order ---')
{
  const limiter = createRateLimiter({ requestsPerSecond: 1000 / INTERVAL, burst: 1, scope: 'model', maxWaitMs: 10000 })
  const COUNT = 6
  const started = Date.now()
  const runs = []
  for (let i = 0; i < COUNT; i++) runs.push(await acquire(limiter, 'gemini-3.6-flash'))
  const overall = Date.now() - started
  const waits = runs.map(run => run.reported)
  console.log(`  waits: ${waits.join(', ')}ms  overall: ${overall}ms for ${COUNT} requests`)
  check('first request starts immediately', waits[0] === 0, `waited ${waits[0]}ms`)
  // A token bucket refills continuously, so each request waits about one interval
  // rather than an interval more than the one before it.
  check(
    'every later request waits about one interval',
    runs.slice(1).every(run => run.reported >= INTERVAL - 5 && run.reported <= INTERVAL * 3),
    `waits ${waits.slice(1).join(', ')}`,
  )
  // The sustained rate is what actually protects the upstream: COUNT requests
  // cannot finish in less than COUNT - 1 intervals.
  check('the sustained rate holds', overall >= (COUNT - 1) * INTERVAL - 15, `${overall}ms for ${COUNT} at ${INTERVAL}ms`)
  check('and is not slower than the configured rate', overall <= (COUNT - 1) * INTERVAL + 150, `${overall}ms`)
}

console.log('\n--- burst: the first `burst` requests start together ---')
{
  const limiter = createRateLimiter({ requestsPerSecond: 1000 / INTERVAL, burst: 3, scope: 'model', maxWaitMs: 10000 })
  const runs = []
  for (let i = 0; i < 4; i++) runs.push(await acquire(limiter, 'gemini-3.6-flash'))
  const waits = runs.map(run => run.reported)
  console.log(`  waits: ${waits.join(', ')}ms`)
  check('a burst of three is not paced', waits[0] === 0 && waits[1] === 0 && waits[2] === 0, `waits ${waits.slice(0, 3).join(', ')}`)
  check('the request past the burst is paced', waits[3] >= INTERVAL - 5, `waited ${waits[3]}ms`)
}

console.log('\n--- scope: separate buckets per model ---')
{
  const limiter = createRateLimiter({ requestsPerSecond: 1000 / INTERVAL, burst: 1, scope: 'model', maxWaitMs: 10000 })
  const first = await acquire(limiter, 'gemini-3.6-flash')
  const second = await acquire(limiter, 'gemini-3.6-flash')
  const other = await acquire(limiter, 'gemini-3.5-flash')
  check('a second model has its own bucket', other.reported === 0, `waited ${other.reported}ms after ${second.reported}ms on the first model`)
  check('the first model still paced', second.reported >= INTERVAL - 5, `waited ${second.reported}ms`)
  check('the first acquisition was immediate', first.reported === 0)
}

console.log('\n--- shared scope: one bucket for every paced model ---')
{
  const limiter = createRateLimiter({ requestsPerSecond: 1000 / INTERVAL, burst: 1, scope: 'shared', maxWaitMs: 10000 })
  await acquire(limiter, 'all')
  const other = await acquire(limiter, 'all')
  check('a different model waits behind the shared bucket', other.reported >= INTERVAL - 5, `waited ${other.reported}ms`)
}

console.log('\n--- refusal: maxWaitMs 0 sends nothing rather than waiting ---')
{
  const limiter = createRateLimiter({ requestsPerSecond: 1000 / INTERVAL, burst: 1, scope: 'model', maxWaitMs: 0 })
  const first = await acquire(limiter, 'gemini-3.6-flash')
  let refusal
  try {
    await limiter.acquire('gemini-3.6-flash')
  } catch (error) {
    refusal = error
  }
  check('the free slot is used', first.reported === 0)
  check('the next request is refused', refusal instanceof RateLimitExceededError, refusal === undefined ? 'nothing thrown' : undefined)
  check('the refusal names the bucket and ceiling', refusal?.key === 'gemini-3.6-flash' && refusal?.maxWaitMs === 0, refusal?.message)
  // A refusal must not wedge the queue behind it.
  await new Promise(resolve => { setTimeout(resolve, INTERVAL + 10) })
  const after = await acquire(limiter, 'gemini-3.6-flash')
  check('a refused request does not stall the queue', after.reported === 0, `waited ${after.reported}ms`)
}

console.log('\n--- end ---')
