// End to end through the real gateway: a third-party-style OpenCode package is
// loaded by the host, the host is registered as a meta-gateway sidecar, a
// channel is created from the host's channel_path, and a chat completion is
// relayed through mg -> host -> plugin -> upstream and back.
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const MG = process.env.MG_BIN || ""
const HOST = new URL("../src/host.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

if (!MG) {
  console.log("MG_BIN is not set — skipping the gateway end-to-end run")
  process.exit(0)
}
const FIXTURE = `
export const FixturePlugin = async () => ({
  auth: {
    provider: "fixture",
    methods: [{ type: "api", label: "Fixture", placeholder: "fk", async authorize() { return { type: "success", key: "fk" } } }],
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
  provider: { id: "fixture", async models() { return { "fixture-large": { name: "Fixture Large" } } } },
})
`

const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const waitFor = async (url, ok, what) => {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(url)
      if (!ok || ok(r)) return r
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${what} never answered ${url}`)
}

const requests = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8")
    requests.push({ url: req.url, authorization: req.headers.authorization || "", body: raw })
    const body = raw ? JSON.parse(raw) : {}
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"choices":[{"delta":{"content":"from the fixture"}}]}\n\n')
      res.write("data: [DONE]\n\n")
      res.end()
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ message: { role: "assistant", content: "from the fixture" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})
await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`

// host data dir with the fixture package
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-host-"))
const pkgDir = path.join(hostDir, "node_modules", "opencode-fixture")
fs.mkdirSync(pkgDir, { recursive: true })
fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "opencode-fixture", version: "1.0.0", type: "module", main: "index.mjs" }))
fs.writeFileSync(path.join(pkgDir, "index.mjs"), FIXTURE)
fs.writeFileSync(
  path.join(hostDir, "host.json"),
  JSON.stringify({ packages: [{ spec: "opencode-fixture", name: "opencode-fixture", dir: pkgDir, main: "index.mjs", version: "1.0.0", enabled: true }] }),
)

const hostPort = await freePort()
const host = spawn(process.execPath, [HOST], {
  env: { ...process.env, META_GATEWAY_PLUGIN_DIR: hostDir, META_GATEWAY_PLUGIN_PORT: String(hostPort), META_GATEWAY_PLUGIN_ADDR: "127.0.0.1", FIXTURE_BASE: upstreamBase },
  stdio: ["ignore", "pipe", "pipe"],
})
let hostLog = ""
host.stderr.on("data", (c) => (hostLog += c))
const hostBase = `http://127.0.0.1:${hostPort}`

const mgDir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-data-"))
const mgPort = await freePort()
const mg = spawn(MG, [], {
  env: {
    ...process.env,
    HTTP_ADDR: `127.0.0.1:${mgPort}`,
    DATA_DIR: mgDir,
    PLUGINS_DIR: path.join(mgDir, "plugins"),
    ADMIN_TOKEN: "admin-test",
    MASTER_KEY: "integration-test-master-key-32-chars",
    METRICS_TOKEN: "metrics-test",
    OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let mgLog = ""
mg.stderr.on("data", (c) => (mgLog += c))
mg.stdout.on("data", (c) => (mgLog += c))

const mgBase = `http://127.0.0.1:${mgPort}`
const admin = async (p, body, method) => {
  const r = await fetch(mgBase + p, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const hostAPI = async (p, body, method) => {
  const r = await fetch(hostBase + p, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

try {
  await waitFor(`${hostBase}/healthz`, (r) => r.ok, "the host")
  await waitFor(`${mgBase}/healthz`, (r) => r.ok, "the gateway")
  console.log("both up: host", hostPort, "mg", mgPort)

  await hostAPI("/api/signin/api", { provider: "fixture" })
  const models = await hostAPI("/v1/models")
  console.log("host models:", models.data.map((m) => m.id).join(", "))

  const registered = await admin("/admin/plugins/register", { url: hostBase })
  console.log("plugin registered:", JSON.stringify(registered).slice(0, 200))

  const site = await admin("/admin/sites", { name: "fixture-site", base_url: `${hostBase}/v1`, platform: "openai", status: "enabled" })
  const credential = await admin(`/admin/sites/${site.id}/credentials`, { kind: "api_key", secret: "channel-secret", status: "enabled" })
  const channel = await admin("/admin/channels", {
    site_id: site.id,
    credential_id: credential.id,
    name: "opencode-host",
    base_url: `${hostBase}/v1`,
    type_hint: "openai",
    status: "enabled",
    models_csv: "fixture-large",
  })
  const route = await admin("/admin/routes", { model_pattern: "fixture-large", enabled: true })
  await admin(`/admin/routes/${route.id}/members`, { channel_id: channel.id, priority: 1, weight: 100, enabled: true })
  const key = await admin("/admin/downstream-keys", { name: "client", scopes: "relay" })
  console.log("channel", channel.id, "route", route.id, "key", key.token.slice(0, 12) + "…")

  const chat = await fetch(`${mgBase}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-large", messages: [{ role: "user", content: "hi" }] }),
  })
  const chatBody = await chat.text()
  console.log("chat:", chat.status, chatBody.slice(0, 220))
  console.log("upstream saw:", JSON.stringify(requests.at(-1)).slice(0, 260))

  const stream = await fetch(`${mgBase}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-large", stream: true, messages: [] }),
  })
  const streamBody = await stream.text()
  console.log("stream:", stream.status, stream.headers.get("content-type"), "|", streamBody.replace(/\n/g, "\\n").slice(0, 160))

  const logs = await admin("/admin/proxy-logs?limit=2")
  for (const row of logs.logs || []) {
    console.log("log row:", row.status, row.model, "channel", row.channel_id, "status_code", row.status_code, "upstream", row.upstream_url)
  }
} catch (err) {
  console.log("FAILED:", err.message)
  console.log("host log:", hostLog.split("\n").slice(-6).join("\n"))
  console.log("mg log:", mgLog.split("\n").slice(-15).join("\n"))
  process.exitCode = 1
} finally {
  host.kill()
  mg.kill()
  upstream.close()
  fs.rmSync(hostDir, { recursive: true, force: true })
  fs.rmSync(mgDir, { recursive: true, force: true })
}
