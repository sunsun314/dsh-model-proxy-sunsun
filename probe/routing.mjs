/**
 * Offline probe for the model-name readers.
 *
 * The routing decision reads a model name from one of two places: the request
 * path (the native Google APIs) or the JSON body (OpenAI-compatible gateways).
 * Both readers are pure, so this probe needs no network, no proxy, and no
 * credential — run it anywhere.
 *
 * Usage: node probe/routing.mjs
 *
 * @module dsh-model-proxy/probe/routing
 */

import { modelFromPath } from '../index.js'

/** Assert one reader result. */
function check(name, actual, expected) {
  const verdict = actual === expected ? 'PASS' : 'FAIL'
  console.log(`${verdict}  ${name}`)
  if (actual !== expected) {
    console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    process.exitCode = 1
  }
}

console.log('--- modelFromPath: Google Generative AI ---')
check(
  'streamGenerateContent',
  modelFromPath('/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse'),
  'gemini-3.6-flash',
)
check(
  'generateContent',
  modelFromPath('/v1beta/models/gemini-2.5-flash:generateContent'),
  'gemini-2.5-flash',
)
check(
  'models prefix stripped by the SDK',
  modelFromPath('/v1beta/models/gemini-3.8-flash:countTokens'),
  'gemini-3.8-flash',
)
check(
  'tunedModels',
  modelFromPath('/v1beta/tunedModels/my-tuned-model:generateContent'),
  'my-tuned-model',
)
check(
  'embedContent',
  modelFromPath('/v1beta/models/gemini-embedding-001:embedContent'),
  'gemini-embedding-001',
)

console.log('\n--- modelFromPath: Vertex AI ---')
check(
  'publishers path',
  modelFromPath('/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent'),
  'gemini-2.5-pro',
)

console.log('\n--- modelFromPath: must not invent a model ---')
check('collection path with query', modelFromPath('/v1beta/models?pageSize=10'), undefined)
check('bare collection path', modelFromPath('/v1beta/models'), undefined)
check('collection path with slash', modelFromPath('/v1beta/models/'), undefined)
check('OpenAI-compatible path names no model', modelFromPath('/zen/go/v1/chat/completions'), undefined)
check('OpenCode catalogue path names no model', modelFromPath('/zen/go/v1/models'), undefined)
check('non-string path', modelFromPath(undefined), undefined)

console.log('\n--- end ---')
