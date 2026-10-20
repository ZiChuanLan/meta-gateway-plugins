import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HOST_ENTRY = path.join(ROOT, "src", "host.mjs")

// The fixture is a package written the way other authors' packages are: it
// exports a plugin function, declares an api sign-in, and answers through a
// `fetch` the loader returned. Writing it here rather than installing one from
// npm keeps the test offline while running the same code path.
const FIXTURE_PLUGIN = `
export const FixturePlugin = async (input) => ({
  auth: {
    provider: "fixture",
    methods: [
      {
        type: "api",
        label: "Fixture key",
        placeholder: "fixture-key",
        async authorize() { return { type: "success", key: "fixture-key" } },
      },
    ],
    async loader(getAuth) {
      const auth = await getAuth()
      if (!auth) return {}
      return {
        baseURL: process.env.FIXTURE_BASE,
        apiKey: auth.key,
        async fetch(url, init) {
          const headers = new Headers(init?.headers || {})
          headers.set("authorization", "Bearer " + auth.key)
          return fetch(url, { ...init, headers })
        },
      }
    },
  },
  provider: {
    id: "fixture",
    async models() {
      return { "fixture-large": { name: "Fixture Large", limit: { context: 1000, output: 100 } } }
    },
  },
})
`

// startUpstream answers whatever the host sends it and keeps the last request
// so the test can see exactly what crossed the wire.
function startUpstream(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => {
        state.requests.push({
          url: req.url,
          authorization: req.headers.authorization || "",
          body: Buffer.concat(chunks).toString("utf8"),
        })
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n')
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "x", model: parsed.model, choices: [{ message: { content: "answered" } }] }))
      })
    })
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

// startHost writes the fixture package into a temp dir and starts the host
// exactly as meta-gateway would: managed process, plugin dir, port.
async function startHost(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-host-"))
  const pkgDir = path.join(dir, "node_modules", "opencode-fixture")
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "opencode-fixture", version: "1.0.0", type: "module", main: "index.mjs" }),
  )
  fs.writeFileSync(path.join(pkgDir, "index.mjs"), FIXTURE_PLUGIN)
  fs.writeFileSync(
    path.join(dir, "host.json"),
    JSON.stringify({
      packages: [{ spec: "opencode-fixture", name: "opencode-fixture", dir: pkgDir, main: "index.mjs", version: "1.0.0", enabled: true }],
    }),
  )
  const port = await freePort()
  const child = spawn(process.execPath, [HOST_ENTRY], {
    env: {
      ...process.env,
      META_GATEWAY_PLUGIN_DIR: dir,
      META_GATEWAY_PLUGIN_PORT: String(port),
      META_GATEWAY_PLUGIN_ADDR: "127.0.0.1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stderr.on("data", (chunk) => {
    log += chunk.toString("utf8")
  })
  const base = `http://127.0.0.1:${port}`
  const started = await waitFor(`${base}/healthz`, () => log)
  assert.equal(started.status, 200, `host did not start: ${log}`)
  return { base, dir, child, log: () => log }
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(url, log) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await fetch(url)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`the host never answered ${url}\n${log()}`)
}

async function call(base, path, init) {
  const response = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text, headers: response.headers }
}

test("serves the manifest meta-gateway expects", async (t) => {
  const host = await startHost({})
  t.after(() => host.child.kill())
  const manifest = await call(host.base, "/plugin.json")
  assert.equal(manifest.status, 200)
  assert.equal(manifest.body.id, "opencode-host")
  assert.equal(manifest.body.channel_path, "/v1")
  assert.equal(manifest.body.health_path, "/healthz")
})

test("a signed-in provider answers chat completions through its own fetch", async (t) => {
  const state = { requests: [] }
  const upstream = await startUpstream(state)
  t.after(() => upstream.close())
  const host = await startHost({ FIXTURE_BASE: `http://127.0.0.1:${upstream.address().port}/v1` })
  t.after(() => host.child.kill())

  // Before signing in the package reports itself, and lists its models.
  const before = await call(host.base, "/api/state")
  assert.equal(before.status, 200)
  assert.equal(before.body.providers[0].id, "fixture")
  assert.equal(before.body.providers[0].signedIn, false)

  const models = await call(host.base, "/v1/models")
  assert.equal(models.status, 200)
  assert.deepEqual(
    models.body.data.map((row) => row.id),
    ["fixture/fixture-large"],
  )

  // Signing in runs the package's own authorize(), so a package that needs no
  // real key (Zen's public one) is one click.
  const signed = await call(host.base, "/api/signin/api", {
    method: "POST",
    body: JSON.stringify({ provider: "fixture" }),
  })
  assert.equal(signed.status, 200, signed.text)
  assert.equal(signed.body.method, "api")

  const answer = await call(host.base, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "fixture-large", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(answer.status, 200, answer.text)
  assert.equal(answer.body.choices[0].message.content, "answered")

  // The package saw the model name without the host's provider prefix, and its
  // own fetch added the credential it was signed in with.
  assert.equal(state.requests.length, 1)
  assert.match(state.requests[0].url, /\/v1\/chat\/completions$/)
  assert.equal(JSON.parse(state.requests[0].body).model, "fixture-large")
  assert.equal(state.requests[0].authorization, "Bearer fixture-key")
})

test("a streamed answer is passed through as it arrives", async (t) => {
  const state = { requests: [] }
  const upstream = await startUpstream(state)
  t.after(() => upstream.close())
  const host = await startHost({ FIXTURE_BASE: `http://127.0.0.1:${upstream.address().port}/v1` })
  t.after(() => host.child.kill())
  await call(host.base, "/api/signin/api", { method: "POST", body: JSON.stringify({ provider: "fixture" }) })

  const answer = await call(host.base, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "fixture-large", stream: true, messages: [] }),
  })
  assert.equal(answer.status, 200)
  assert.match(answer.headers.get("content-type") || "", /event-stream/)
  assert.match(answer.text, /"content":"streamed"/)
  assert.match(answer.text, /\[DONE\]/)
})

test("a model naming a provider this host does not run is refused", async (t) => {
  const state = { requests: [] }
  const upstream = await startUpstream(state)
  t.after(() => upstream.close())
  const host = await startHost({ FIXTURE_BASE: `http://127.0.0.1:${upstream.address().port}/v1` })
  t.after(() => host.child.kill())
  await call(host.base, "/api/signin/api", { method: "POST", body: JSON.stringify({ provider: "fixture" }) })

  // An explicit <provider>/ prefix is an instruction: honouring it on a
  // package that is not loaded would send the request somewhere else.
  const answer = await call(host.base, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "ghost-model/anything", messages: [] }),
  })
  assert.equal(answer.status, 502)
  assert.match(answer.body.error.message, /no provider named ghost-model is loaded/)
})

test("a hand-typed model reaches the plugin, which decides", async (t) => {
  const state = { requests: [] }
  const upstream = await startUpstream(state)
  t.after(() => upstream.close())
  const host = await startHost({ FIXTURE_BASE: `http://127.0.0.1:${upstream.address().port}/v1` })
  t.after(() => host.child.kill())
  await call(host.base, "/api/signin/api", { method: "POST", body: JSON.stringify({ provider: "fixture" }) })

  // With one provider, a name it does not list is forwarded: an operator who
  // typed it into the channel knows something the listing does not.
  const answer = await call(host.base, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "typed-by-hand", messages: [] }),
  })
  assert.equal(answer.status, 200, answer.text)
  assert.equal(JSON.parse(state.requests[0].body).model, "typed-by-hand")
})

test("the admin API needs the plugin key when one is set", async (t) => {
  const host = await startHost({ META_GATEWAY_PLUGIN_KEY: "sekrit" })
  t.after(() => host.child.kill())

  const refused = await call(host.base, "/api/state")
  assert.equal(refused.status, 401)

  const allowed = await call(host.base, "/api/state", { headers: { "x-plugin-key": "sekrit" } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.body.providers[0].id, "fixture")

  // A channel pointed at {host}/v1 authenticates like any OpenAI upstream: the
  // key travels as a bearer token, not as the plugin proxy header.
  const asChannel = await call(host.base, "/api/state", { headers: { authorization: "Bearer sekrit" } })
  assert.equal(asChannel.status, 200)
})

// The gateway hands the sidecar its whole listen address ("127.0.0.1:PORT") in
// META_GATEWAY_PLUGIN_ADDR. Taking that as the *host* binds nothing and the
// process exits, which the gateway reports as plugin_health_check_failed — so
// the address is split, and this pins it.
test("listens when the address it is given includes the port", async (t) => {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-host-addr-"))
  const child = spawn(process.execPath, [HOST_ENTRY], {
    env: {
      ...process.env,
      META_GATEWAY_PLUGIN_DIR: dir,
      META_GATEWAY_PLUGIN_ADDR: `127.0.0.1:${port}`,
      META_GATEWAY_PLUGIN_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stderr.on("data", (chunk) => (log += chunk.toString("utf8")))
  t.after(() => {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const answer = await waitFor(`http://127.0.0.1:${port}/healthz`, () => log)
  assert.equal(answer.status, 200, `host bound nothing: ${log}`)
})

// The console embeds the page in a sandboxed iframe, which gives it an opaque
// origin: without these headers every fetch it makes fails and the page looks
// broken while the API is fine.
test("answers a sandboxed page: CORS on responses and on preflight", async (t) => {
  const host = await startHost()
  t.after(() => host.child.kill())

  const plain = await fetch(`${host.base}/api/state`)
  assert.equal(plain.headers.get("access-control-allow-origin"), "*")

  const preflight = await fetch(`${host.base}/api/packages`, {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*")
  assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/)
})
