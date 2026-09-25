# dsh-model-proxy

Per-model outbound proxy routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
with a direct fallback while the proxy is unavailable.

One gateway can serve different models through different upstreams, and those
upstreams do not share the same reachability. A model routed to an upstream that
is region-restricted, rate-limited, or only reachable through a corporate proxy
fails for reasons that have nothing to do with the model next to it in the same
picker — same host, same key, same request shape.

An environment proxy cannot express that distinction: `HTTP_PROXY` routes by
host, and both models share one host. Routing the whole gateway through the
proxy drags the working models along with the broken ones; routing nothing
leaves the broken ones broken.

`dsh-model-proxy` reads the model name out of each request and sends only the
models you name through the proxy.

## How it routes

DSH, pi-ai, and the provider SDKs issue requests through `globalThis.fetch`,
which resolves undici's well-known global dispatcher slot
(`Symbol.for('undici.globalDispatcher.1')`). The plugin owns that slot and
decides in this order:

1. **Origin** — a request to a host outside `origins`, or one carrying no body,
   keeps the route that was installed before this plugin loaded.
2. **Proxy reachability** — while `fallbackToDirect` is set and the proxy's
   `host:port` refuses a TCP connection, candidate requests keep that previous
   route too. A stopped proxy then costs you the proxied models and nothing
   else, instead of failing every call.
3. **Model name** — the head of the request body is read for its `"model"`
   field, and the request goes through `proxy` when that name matches one of
   `models`.

Only the first chunks of the body are held, and the held chunks are yielded
before the rest of the stream, so chunk boundaries, backpressure, and streaming
responses are unchanged.

`direct` means *the route the process already had*. With no proxy in the launch
environment that is a direct connection, so an unconfigured deployment behaves
exactly as it did before the plugin was installed.

## Install

Register the bundle in the target profile's `package.json`
(`<DSH_HOME>/profiles/<profile>/package.json`):

```json
{
  "dependencies": {
    "dsh-model-proxy": "github:windwhiterain/dsh-model-proxy"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-model-proxy"]
    }
  }
}
```

`link:C:/path/to/dsh-model-proxy` works for local development. Then install the
profile and restart dsh once; the bundle's own `cordis.patch.yml` inserts the
`model-proxy` row with the defaults below.

**Do not also set `HTTP_PROXY`/`HTTPS_PROXY` for the dsh process.** A proxy in
the launch environment makes dsh install its own process-wide dispatcher, which
this plugin then treats as the route to keep for everything it does not proxy —
the opposite of the intent. Leave the launch environment direct and let this
plugin be the only thing that proxies anything.

## Configuration

```yaml
- id: model-proxy
  config:
    enabled: true
    proxy: http://127.0.0.1:10793
    origins:
      - opencode.ai
    models:
      - grok-*
      - gpt-*-luna
    fallbackToDirect: true
    probeTimeoutMs: 300
    probeCacheMs: 2000
    peekBytes: 16384
```

| Field | Meaning |
| --- | --- |
| `enabled` | When false the plugin installs nothing and every request keeps its route. |
| `proxy` | Endpoint the matching models use. `http:` or `https:`, with optional credentials. |
| `origins` | Hosts whose models may be routed. Requests to every other host are untouched. |
| `models` | Model patterns; `*` matches any run of characters, every other character matches itself. |
| `fallbackToDirect` | While the proxy refuses connections, matching requests use the previous route instead of failing. |
| `probeTimeoutMs` | TCP connect timeout for the reachability probe. |
| `probeCacheMs` | How long one probe verdict is reused, so a burst of requests probes once. |
| `peekBytes` | How many body bytes may be inspected before giving up on finding a model name. |

Edit the row in `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` (hot-reloaded),
or override the same `id` from a settings layer. A configuration value that
cannot be used fails the activation instead of silently routing traffic to the
wrong place.

## Recipes

**Region-restricted upstreams behind one gateway.** OpenCode Go serves `grok-*`
and `gpt-*-luna` through upstreams that answer
`unsupported_country_region_territory` from a blocked region, while GLM, Kimi,
DeepSeek and the rest of the catalogue answer normally from that same region and
that same API key. The configuration above sends only the two restricted
families through a proxy in a supported region; every other model stays direct,
and stopping the proxy leaves them all working.

When calling that gateway directly, note that it refuses any request without an
`x-opencode-session` header (`400 MissingSessionID`), independently of this
plugin.

**One provider behind a corporate proxy.**

```yaml
- id: model-proxy
  config:
    proxy: http://proxy.corp.example:3128
    origins: [api.example.com]
    models: ['*']
```

**A whole gateway through a different egress, with the rest of the process
untouched.** Same as the corporate case with `models: ['*']` — the routing is
still per request, so a host you later add elsewhere is unaffected.

## Diagnostics

Each decision is logged through the host logger:

```
dsh-model-proxy: models grok-*, gpt-*-luna on opencode.ai via http://127.0.0.1:10793, direct while it is down
dsh-model-proxy: route=proxy via=http://127.0.0.1:10793 reason=model:grok-4.7
dsh-model-proxy: route=direct via=direct reason=model-other:glm-5.3-flash
dsh-model-proxy: route=direct via=direct reason=proxy-down
dsh-model-proxy: route=direct via=direct reason=origin
```

On unload the plugin restores the dispatcher it displaced, so a later plugin can
still claim the slot.

## Probe

```sh
node probe/smoke.mjs              # proxy reachable
node probe/smoke.mjs --proxy-down # fallback
```

The probe boots the plugin against a stub context and drives real requests
through the installed dispatcher, asserting both the chosen route and the
integrity of the response body. It reads the API key from the DSH credential
store, so point the config at credentials you hold before running it.
`node probe/decode-matrix.mjs <baseline|agent8|proxy8|wrapper8>` isolates the
undici hazard described below from the routing logic.

## Compatibility

- **Node 24 built-in `fetch`.** The plugin relies on the global dispatcher slot
  that Node's own `fetch` resolves; no Node version that ships `fetch` is
  otherwise assumed.
- **`undici` is pinned to `~8.10.0` on purpose.** 8.11.0 drops
  `content-encoding` and hands the body to `fetch` undecoded once it owns the
  global dispatcher under Node 24 — every response in the process arrives as
  raw bytes. 8.10.x and 7.x are unaffected. Raising the pin requires re-running
  the probe's body assertions.
- **DSH's own proxy package has the same exposure**: `@deepseek-ai/dsh-http-proxy`
  declares `undici: ^8.10.0`, so a lockfile refresh past 8.11.0 breaks the
  harness's own proxy support the same way.

## Known limitations

- **In-process calls only.** The decision lives inside the dsh process, so a
  `curl` or `git` started by a shell tool does not follow it. Those follow the
  launch environment, which this plugin deliberately leaves alone.
- **The model is read from the body.** A request that names its model only in a
  header, or whose body exceeds `peekBytes` before the `model` field, is not
  matched and keeps the direct route.
- **A reachable proxy that fails upstream is not detected.** The probe answers
  "is something listening", not "does the proxy work"; that request fails.
- **One proxy per row.** Routing different model families to different proxies
  needs more than one row, which the current implementation does not support.

## License

MIT
