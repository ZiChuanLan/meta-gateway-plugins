#!/usr/bin/env node
// meta-gateway sidecar: runs OpenCode provider plugins from npm, as they are.
//
// The packages this loads are other authors' work — @magpie-community/*, and
// anything else built for OpenCode's provider plugin API. Nothing here is
// compiled per vendor: a package is installed with npm, imported, and its
// `auth.loader` fetch answers the gateway's requests. Adding a subscription is
// installing a package and signing in, which is the point.
//
// The contract this implements is the one those packages are written against:
//
//   export const XPlugin = async (input) => ({
//     config(cfg)               register provider config
//     auth: { provider, methods: [{type:"api"|"oauth", ...}],
//             loader(getAuth) -> { baseURL, apiKey, fetch(input, init) } }
//     provider: { id, models(providerConf, {auth}) }
//   })
//
// A request arrives from meta-gateway as an OpenAI chat completion on /v1 and
// leaves as the URL the plugin's loader named, in the body the plugin expects.

import { execFile } from "node:child_process"
import fs from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

const DIR = process.env.META_GATEWAY_PLUGIN_DIR || path.join(process.cwd(), "data")
const PLUGIN_KEY = process.env.META_GATEWAY_PLUGIN_KEY || ""
const PORT = Number(process.env.META_GATEWAY_PLUGIN_PORT || process.env.PORT || 9300)
// The gateway passes the whole listen address as META_GATEWAY_PLUGIN_ADDR
// ("127.0.0.1:PORT") and the port again on its own, so the address is split
// here: listening on "host:port" as the *host* fails, which shows up as a
// plugin that starts and immediately exits.
const RAW_ADDR = process.env.META_GATEWAY_PLUGIN_ADDR || "0.0.0.0"
const BIND = /^[^:]+:\d+$/.test(RAW_ADDR) ? RAW_ADDR.slice(0, RAW_ADDR.lastIndexOf(":")) : RAW_ADDR
const STATE_FILE = path.join(DIR, "host.json")
const AUTH_FILE = path.join(DIR, "auth.json")
const MODELS_TTL = 60_000

fs.mkdirSync(DIR, { recursive: true })

// ---------------------------------------------------------------- files

function readJSON(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJSON(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// state is what the operator installed: one entry per npm package.
const state = readJSON(STATE_FILE, { packages: [] })
if (!Array.isArray(state.packages)) state.packages = []

function saveState() {
  writeJSON(STATE_FILE, state)
}

// accounts are kept in OpenCode's auth.json shape, one per provider id, in the
// file's own 0600 mode: an access token is a credential.
const accounts = readJSON(AUTH_FILE, {})

function saveAccounts() {
  writeJSON(AUTH_FILE, accounts)
}

// ---------------------------------------------------------------- loading

// loaded maps provider id -> what its package's plugin function returned, plus
// the package it came from. Rebuilt whenever the installed set changes.
const loaded = new Map()
const modelsCache = new Map() // provider id -> {at, ids}

// pluginInput is what OpenCode hands a plugin. Only the parts these packages
// actually reach for are real; the rest answers as an empty answer rather than
// throwing, so one plugin asking for a feature cannot stop the others loading.
function pluginInput() {
  const $ = () => {
    throw new Error("this host does not run shell commands for plugins")
  }
  return {
    project: { id: "meta-gateway", vcs: "git", worktree: DIR, time: { created: Date.now() } },
    directory: DIR,
    worktree: DIR,
    $,
    client: {
      auth: {
        get: async ({ path: key } = {}) => accounts[key],
        set: async ({ path: key, body } = {}) => {
          if (key) {
            accounts[key] = body
            saveAccounts()
          }
        },
        remove: async ({ path: key } = {}) => {
          delete accounts[key]
          saveAccounts()
        },
      },
      app: { log: async ({ body } = {}) => console.error(`[plugin] ${body?.message ?? ""}`) },
      config: { get: async () => ({ data: { provider: {} } }) },
      session: { list: async () => ({ data: [] }) },
    },
    tui: { showToast: async () => {} },
  }
}

// pickPluginFn finds the plugin function in a package's exports: the default
// export when it is one, else the first exported function. Packages export it
// under their own name (ZenFreePlugin, …), which is the only convention.
function pickPluginFn(mod) {
  if (typeof mod.default === "function") return mod.default
  for (const value of Object.values(mod)) {
    if (typeof value === "function") return value
  }
  return null
}

let reloading = null

// reload imports every enabled package and calls its plugin function. One
// package that fails is reported and skipped: the rest of the host still
// serves, which is what keeps a bad install from taking the gateway's channel
// down with it.
async function reload() {
  if (reloading) return reloading
  reloading = (async () => {
    const next = new Map()
    const errors = []
    for (const entry of state.packages) {
      if (entry.enabled === false) continue
      try {
        const mod = await import(`${pathToFileURL(path.join(entry.dir, entry.main)).href}?v=${Date.now()}`)
        const plugin = pickPluginFn(mod)
        if (!plugin) throw new Error("the package exports no plugin function")
        const hooks = await plugin(pluginInput())
        if (!hooks || typeof hooks !== "object") throw new Error("the plugin returned no hooks")
        const id = hooks.auth?.provider || hooks.provider?.id
        if (!id) throw new Error("the plugin names no provider")
        const conf = { provider: {} }
        if (typeof hooks.config === "function") {
          try {
            await hooks.config(conf)
          } catch (err) {
            console.error(`[plugin] ${entry.spec} config(): ${err?.message ?? err}`)
          }
        }
        next.set(id, { entry, hooks, providerConf: conf.provider?.[id] ?? {}, id })
      } catch (err) {
        errors.push({ spec: entry.spec, error: String(err?.message ?? err) })
        console.error(`[plugin] ${entry.spec} failed to load: ${err?.message ?? err}`)
      }
    }
    loaded.clear()
    modelsCache.clear()
    for (const [id, value] of next) loaded.set(id, value)
    return errors
  })().finally(() => {
    reloading = null
  })
  return reloading
}

// ---------------------------------------------------------------- install

// npmCommand says how to run npm. The JavaScript CLI is preferred because it
// needs no shell: an operator's spec reaches npm as one argv entry, so a name
// can never become a command. Windows only falls back to npm.cmd (which Node
// refuses to spawn without a shell) behind a strict name check.
function npmCommand(args) {
  const beside = path.dirname(process.execPath)
  const candidates = [
    process.env.npm_execpath,
    path.join(beside, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(beside, "node_modules", "npm", "bin", "npm-cli.mjs"),
  ]
  for (const cli of candidates) {
    if (cli && /\.m?js$/.test(cli) && fs.existsSync(cli)) {
      return { file: process.execPath, args: [cli, ...args], shell: false }
    }
  }
  return { file: "npm", args, shell: false }
}

// SAFE_SPEC is what npm.cmd's fallback may receive: a package name or a path,
// never a shell operator.
const SAFE_SPEC = /^[@\w.\\/:~+-]+$/

// A package name, optionally pinned: what can be fetched straight from the
// registry. Anything else (a path, a git URL, a tarball) needs npm.
const REGISTRY_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~-]+)?$/i

// installFromRegistry is the whole of what installing a provider package needs.
// Those packages have no dependencies of their own (checked, and stated as the
// convention in the plugins repository), so this is: read the registry entry,
// take the tarball, unpack it, move it into place. That removes the need for
// npm — and therefore for Node — at run time, which is what lets the host ship
// as a single self-contained binary.
async function installFromRegistry(spec) {
  const at = spec.lastIndexOf("@")
  const name = at > 0 ? spec.slice(0, at) : spec
  const wanted = at > 0 ? spec.slice(at + 1) : ""
  const meta = await fetchJSON(`https://registry.npmjs.org/${name}`)
  const version = wanted && wanted !== "latest" ? wanted.replace(/^[\^~]/, "") : meta["dist-tags"]?.latest
  if (!version) throw new Error(`the registry knows no version of ${name}`)
  const release = meta.versions?.[version]
  if (!release?.dist?.tarball) throw new Error(`${name}@${version} has no tarball in the registry`)
  if (release.dependencies && Object.keys(release.dependencies).length) {
    // No dependency resolution here, on purpose: a package that grows
    // dependencies needs `npm install` and should say so.
    throw new Error(`${name}@${version} declares dependencies (${Object.keys(release.dependencies).join(", ")}); install it with npm instead`)
  }

  const tmp = fs.mkdtempSync(path.join(DIR, ".install-"))
  try {
    const tarball = path.join(tmp, "package.tgz")
    const response = await fetch(release.dist.tarball, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`downloading ${release.dist.tarball} answered HTTP ${response.status}`)
    fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
    // System tar unpacks the payload; its `package/` prefix is stripped by
    // moving that one directory into place, which busybox tar can do too.
    await run("tar", ["-xzf", tarball, "-C", tmp])
    const payload = path.join(tmp, "package")
    if (!fs.existsSync(path.join(payload, "package.json"))) throw new Error(`${name}@${version} has no package.json in its tarball`)
    const target = path.join(DIR, "node_modules", ...name.split("/"))
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(payload, target)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const dir = path.join(DIR, "node_modules", ...name.split("/"))
  const entry = packageEntry(dir, name)
  return { spec: name, dir, name: entry.name, main: entry.main, version: entry.version || version, enabled: true }
}

async function fetchJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-4).join("\n")))
      resolve(stdout)
    })
  })
}

function npmInstall(spec) {
  return new Promise((resolve, reject) => {
    const args = ["install", "--prefix", DIR, "--no-audit", "--no-fund", "--omit=dev", "--silent", spec]
    const command = npmCommand(args)
    if (process.platform === "win32" && command.file === "npm") {
      // No npm-cli.js beside this node: npm.cmd needs a shell, so the spec has
      // to be checkable first.
      if (!SAFE_SPEC.test(spec)) return reject(new Error(`refusing to pass ${JSON.stringify(spec)} to a shell`))
      command.file = "npm.cmd"
      command.shell = true
    }
    execFile(command.file, command.args, { timeout: 300_000, windowsHide: true, shell: command.shell }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-6).join("\n")))
      resolve()
    })
  })
}

// packageEntry reads an installed package's manifest and works out its entry
// file, so a package that ships its own `main`/`exports` is loaded as its
// author intended.
function packageEntry(dir, spec) {
  const pkg = readJSON(path.join(dir, "package.json"), null)
  if (!pkg) throw new Error(`${spec} has no package.json in ${dir}`)
  let main = pkg.main
  if (!main && pkg.exports) {
    const root = typeof pkg.exports === "string" ? pkg.exports : pkg.exports["."]
    main = typeof root === "string" ? root : root?.import || root?.default
  }
  return { name: pkg.name || spec, main: main || "index.mjs", version: pkg.version || "" }
}

// installedName says which package an install added: npm records it in this
// directory's package.json, and a spec may be a path (a clone, a fork) whose
// manifest name is the only right answer.
function installedName(before, spec) {
  const deps = readJSON(path.join(DIR, "package.json"), {}).dependencies || {}
  const added = Object.keys(deps).filter((key) => !before.has(key))
  if (added.length === 1) return added[0]
  if (deps[spec]) return spec
  const wanted = spec.replace(/@[^/]*$/, "")
  if (added.includes(wanted)) return wanted
  if (added.length) return added[0]
  return wanted
}

async function installPackage(spec) {
  spec = String(spec || "").trim()
  if (!spec) throw new Error("a package name is required")
  const before = new Set(Object.keys(readJSON(path.join(DIR, "package.json"), {}).dependencies || {}))
  const row = REGISTRY_SPEC.test(spec) ? await installFromRegistry(spec) : await installWithNpm(spec, before)
  const existing = state.packages.findIndex((p) => p.spec === row.spec)
  if (existing >= 0) state.packages[existing] = row
  else state.packages.push(row)
  saveState()
  const errors = await reload()
  return { installed: row, errors }
}

// installWithNpm is the fallback for anything the registry cannot answer: a
// path, a git URL, a tarball.
async function installWithNpm(spec, before) {
  await npmInstall(spec)
  const name = installedName(before, spec)
  const dir = path.join(DIR, "node_modules", ...name.split("/"))
  const entry = packageEntry(dir, name)
  return { spec: name, dir, name: entry.name, main: entry.main, version: entry.version, enabled: true }
}

async function removePackage(spec) {
  const index = state.packages.findIndex((p) => p.spec === spec)
  if (index < 0) throw new Error(`${spec} is not installed here`)
  state.packages.splice(index, 1)
  saveState()
  await reload()
}

// ---------------------------------------------------------------- providers

// providerFor resolves the account's auth into the URL and fetch a request
// uses. The loader is called every time, as OpenCode calls it: a package that
// refreshes its own token in there sees the refresh on the next request.
async function providerFor(id) {
  const row = loaded.get(id)
  if (!row) throw new Error(`provider ${id} is not loaded`)
  const auth = async () => accounts[id]
  const loader = row.hooks.auth?.loader
  if (typeof loader !== "function") throw new Error(`provider ${id} has no sign-in loader`)
  const options = await loader(auth)
  if (!options || typeof options !== "object") throw new Error(`provider ${id} returned no options`)
  return { ...options, hooks: row.hooks, auth, conf: row.providerConf }
}

// directFetch is the fetch for a loader that names a base URL and a key but no
// fetch of its own.
function directFetch(options) {
  return (input, init = {}) => {
    const headers = { ...(init.headers || {}) }
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
    return fetch(input, { ...init, headers })
  }
}

// modelIDs lists a provider's models the way the package reports them. A
// package that answers with a config-shaped object (id -> {name}) and one that
// answers with a list are both read.
async function modelIDs(id) {
  const cached = modelsCache.get(id)
  if (cached && Date.now() - cached.at < MODELS_TTL) return cached.ids
  const row = loaded.get(id)
  if (!row) return []
  let ids = []
  try {
    if (typeof row.hooks.provider?.models === "function") {
      const listed = await row.hooks.provider.models(row.providerConf, { auth: accounts[id] })
      ids = normalizeModels(listed)
    }
    if (!ids.length) ids = normalizeModels(row.providerConf?.models)
  } catch (err) {
    console.error(`[plugin] ${id} models(): ${err?.message ?? err}`)
  }
  modelsCache.set(id, { at: Date.now(), ids })
  return ids
}

function normalizeModels(listed) {
  if (!listed) return []
  const fromObject = (object) => Object.entries(object).map(([id, value]) => ({ id: value?.id || id, value }))
  const rows = Array.isArray(listed)
    ? listed.map((item) => ({ id: typeof item === "string" ? item : item?.id, value: item }))
    : typeof listed === "object"
      ? fromObject(listed)
      : []
  return rows
    .filter((row) => typeof row.id === "string" && row.id)
    .map((row) => ({
      id: row.id,
      ...(typeof row.value === "object" && row.value
        ? {
            name: row.value.name,
            context: row.value.limit?.context ?? row.value.context,
            output: row.value.limit?.output ?? row.value.output,
          }
        : {}),
    }))
}

// resolveModel picks the provider that serves a model name. A name written as
// "<provider>/<model>" always wins, so one host can front several packages, and
// a prefix that names no loaded package is an error rather than something to
// ignore: the operator wrote an instruction. Without a prefix the first
// provider that lists the model serves it, and a host with a single provider
// forwards anything else — a model typed into the channel by hand is the
// plugin's to accept or refuse.
async function resolveModel(model) {
  if (typeof model !== "string" || !model) throw new Error("a model name is required")
  const slash = model.indexOf("/")
  if (slash > 0) {
    const prefix = model.slice(0, slash)
    if (loaded.has(prefix)) return { provider: prefix, model: model.slice(slash + 1) }
    throw new Error(`no provider named ${prefix} is loaded here (loaded: ${[...loaded.keys()].join(", ") || "none"})`)
  }
  for (const id of loaded.keys()) {
    const ids = await modelIDs(id)
    if (ids.some((row) => row.id === model)) return { provider: id, model }
  }
  if (loaded.size === 1) return { provider: [...loaded.keys()][0], model }
  throw new Error(`no signed-in provider serves ${model} — name it <provider>/<model>`)
}

// ---------------------------------------------------------------- auth

// signIn stores a credential for one provider. An "api" method may validate
// the key itself (authorize), which is how a package that needs no real key
// (Zen's public one) signs in with a single click.
async function signInAPI(id, key) {
  const row = loaded.get(id)
  if (!row) throw new Error(`provider ${id} is not loaded`)
  const method = (row.hooks.auth?.methods || []).find((m) => m?.type === "api")
  if (!method) throw new Error(`provider ${id} takes no API key`)
  const value = String(key ?? "").trim() || method.placeholder || ""
  if (typeof method.authorize === "function") {
    const result = await method.authorize()
    if (result?.type === "success") {
      accounts[id] = result.key ? { type: "api", key: result.key } : { type: "api", key: value }
      saveAccounts()
      return accounts[id]
    }
    if (result?.type === "failed") throw new Error(result.error || "the package refused this key")
  }
  if (!value) throw new Error("a key is required")
  accounts[id] = { type: "api", key: value }
  saveAccounts()
  return accounts[id]
}

// sign-ins in progress: the callback() a package's oauth authorize returned,
// kept until the operator finishes the browser flow.
const oauth = new Map()

async function oauthStart(id) {
  const row = loaded.get(id)
  if (!row) throw new Error(`provider ${id} is not loaded`)
  const method = (row.hooks.auth?.methods || []).find((m) => m?.type === "oauth")
  if (!method) throw new Error(`provider ${id} has no OAuth sign-in`)
  const result = await method.authorize()
  if (!result?.url) throw new Error("the package returned no sign-in URL")
  if (typeof result.callback === "function") oauth.set(id, { callback: result.callback })
  return { url: result.url, instructions: result.instructions || "", method: result.method || "code" }
}

async function oauthCode(id, code) {
  const pending = oauth.get(id)
  if (!pending) throw new Error(`no sign-in is in progress for ${id}`)
  const result = await pending.callback(String(code ?? "").trim())
  if (result?.type === "failed") throw new Error(result.error || "the package refused this code")
  if (result?.type !== "success") throw new Error("the sign-in did not complete")
  const { type, ...rest } = result
  accounts[id] = { type: "oauth", ...rest }
  saveAccounts()
  oauth.delete(id)
  return accounts[id]
}

function signOut(id) {
  delete accounts[id]
  oauth.delete(id)
  saveAccounts()
}

function accountView(id) {
  const row = loaded.get(id)
  const auth = accounts[id]
  return {
    id,
    name: row?.providerConf?.name || id,
    signedIn: Boolean(auth),
    method: auth?.type || "",
    methods: (row?.hooks?.auth?.methods || []).map((m) => ({
      type: m?.type || "",
      label: m?.label || m?.type || "",
      placeholder: m?.placeholder || "",
    })),
    package: row?.entry?.spec || "",
  }
}

// ---------------------------------------------------------------- http

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

// readPage reads the admin page. Two locations, because the host runs either
// from its source tree or as a compiled binary: next to the executable wins,
// then the development path. A missing page must not take the API down — the
// operator can still install and sign in through it — so it degrades to a
// short note rather than a crash.
function readPage() {
  const candidates = [
    path.join(path.dirname(process.execPath), "index.html"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  ]
  for (const file of candidates) {
    try {
      return fs.readFileSync(file)
    } catch {}
  }
  return Buffer.from(
    "<!doctype html><meta charset=utf-8><title>opencode-host</title>" +
      '<body style="font:14px system-ui;padding:20px"><h1>opencode-host</h1>' +
      "<p>The admin page (index.html) was not found next to this binary. The API still works: " +
      'POST /api/packages {"spec":"…"}, POST /api/signin/api, GET /api/state.</p>',
  )
}

function sendJSON(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req, limit = 32 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("request body is too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

const MANIFEST = {
  id: "opencode-host",
  version: "0.3.0",
  name: "订阅账号宿主",
  description: "在网关里直接运行其他作者的 OpenCode 订阅插件（npm 包）：装包、登录，即可把订阅当上游渠道使用。",
  page_path: "/",
  health_path: "/healthz",
  channel_path: "/v1",
  config_fields: [],
}

function authorized(req, url) {
  if (!PLUGIN_KEY) return true
  // Three callers, three shapes: the gateway's plugin proxy sends X-Plugin-Key,
  // an embedded page sends ?t=, and a channel (base_url = {url}/v1) sends the
  // key as a bearer token like any other OpenAI-compatible upstream.
  if (req.headers["x-plugin-key"] === PLUGIN_KEY) return true
  if (req.headers.authorization === `Bearer ${PLUGIN_KEY}`) return true
  return url.searchParams.get("t") === PLUGIN_KEY
}

function copyHeaders(from) {
  const out = {}
  for (const [key, value] of from.entries()) {
    if (["content-type", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

// forward sends one proxied request to the provider and streams the answer
// back. The answer's status and content type are all the gateway needs: its
// own relay copies the body and measures it.
async function forward(req, res, providerID, upstreamPath) {
  const raw = await readBody(req)
  let payload
  try {
    payload = raw.length ? JSON.parse(raw.toString("utf8")) : undefined
  } catch {
    return sendJSON(res, 400, { error: { message: "the request body is not JSON", type: "invalid_request_error" } })
  }
  const resolved = await resolveModel(payload?.model)
  const wanted = resolved.provider
  if (providerID && providerID !== wanted) {
    return sendJSON(res, 400, {
      error: { message: `this channel serves ${providerID}, the request names ${wanted}`, type: "invalid_request_error" },
    })
  }
  if (payload && typeof payload === "object" && resolved.model !== payload.model) payload.model = resolved.model
  const options = await providerFor(wanted)
  const base = String(options.baseURL || options.baseUrl || "").replace(/\/+$/, "")
  if (!base) throw new Error(`provider ${wanted} named no base URL`)
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const doFetch = typeof options.fetch === "function" ? options.fetch : directFetch(options)
  const headers = { "content-type": "application/json" }
  const response = await doFetch(`${base}/${upstreamPath}`, {
    method: req.method || "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  })
  const answer = response instanceof Response ? response : new Response(String(response))
  res.writeHead(answer.status || 200, { ...copyHeaders(answer.headers), "content-type": answer.headers.get("content-type") || "application/json" })
  if (!answer.body) {
    res.end()
    return
  }
  await new Promise((resolve) => {
    const stream = Readable.fromWeb(answer.body)
    stream.on("error", () => res.destroy())
    stream.on("end", resolve)
    stream.pipe(res)
  })
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost")
  const pathname = url.pathname
  const method = req.method || "GET"

  // The console embeds this page in an iframe WITHOUT allow-same-origin, so its
  // document has an opaque origin and every request it makes is cross-origin:
  // without these headers the page loads and then every fetch fails with
  // "Failed to fetch". The API is credential-gated (key or ?t=), and an opaque
  // origin has no cookies to leak, so a wildcard here is the honest answer.
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization,x-plugin-key")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
  res.setHeader("Access-Control-Max-Age", "600")
  if (method === "OPTIONS") {
    res.writeHead(204)
    return res.end()
  }

  if (pathname === "/healthz") return sendJSON(res, 200, { status: "ok", providers: loaded.size })
  if (pathname === "/plugin.json") return sendJSON(res, 200, MANIFEST)

  if (pathname === "/" || pathname === "/index.html") {
    const html = readPage()
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length })
    return res.end(html)
  }

  const providerID = url.searchParams.get("provider") || ""
  if (pathname.startsWith("/v1/")) {
    const sub = pathname.slice("/v1/".length)
    if (method === "GET" && sub === "models") {
      const data = []
      for (const id of loaded.keys()) {
        for (const row of await modelIDs(id)) {
          data.push({ id: `${id}/${row.id}`, object: "model", owned_by: id, name: row.name, context: row.context })
        }
      }
      return sendJSON(res, 200, { object: "list", data })
    }
    try {
      return await forward(req, res, providerID, sub)
    } catch (err) {
      // The cause is what an operator needs: Node's fetch only says "fetch
      // failed" and keeps the real reason (UND_ERR_CONNECT_TIMEOUT, …) there.
      const cause = err?.cause?.code || err?.cause?.message
      return sendJSON(res, 502, {
        error: { message: cause ? `${err?.message ?? err}: ${cause}` : String(err?.message ?? err), type: "upstream_error" },
      })
    }
  }

  if (!authorized(req, url)) return sendJSON(res, 401, { error: { message: "missing plugin key" } })

  try {
    if (pathname === "/api/state" && method === "GET") {
      const packages = state.packages.map((entry) => ({
        spec: entry.spec,
        name: entry.name,
        version: entry.version,
        enabled: entry.enabled !== false,
      }))
      const providers = [...loaded.keys()].map(accountView)
      return sendJSON(res, 200, { packages, providers, dataDir: DIR })
    }
    if (pathname === "/api/packages" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      const result = await installPackage(body.spec)
      return sendJSON(res, 200, result)
    }
    if (pathname === "/api/packages" && method === "DELETE") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      await removePackage(body.spec)
      return sendJSON(res, 200, { removed: body.spec })
    }
    if (pathname === "/api/enable" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      const entry = state.packages.find((p) => p.spec === body.spec)
      if (!entry) throw new Error(`${body.spec} is not installed here`)
      entry.enabled = Boolean(body.enabled)
      saveState()
      await reload()
      return sendJSON(res, 200, { spec: entry.spec, enabled: entry.enabled })
    }
    if (pathname === "/api/signin/api" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      const stored = await signInAPI(body.provider, body.key)
      return sendJSON(res, 200, { provider: body.provider, method: stored.type })
    }
    if (pathname === "/api/signin/oauth" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      return sendJSON(res, 200, await oauthStart(body.provider))
    }
    if (pathname === "/api/signin/oauth/code" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      const stored = await oauthCode(body.provider, body.code)
      return sendJSON(res, 200, { provider: body.provider, method: stored.type })
    }
    if (pathname === "/api/signin" && method === "DELETE") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      signOut(body.provider)
      return sendJSON(res, 200, { provider: body.provider, signedIn: false })
    }
    return sendJSON(res, 404, { error: { message: `no such endpoint: ${method} ${pathname}` } })
  } catch (err) {
    return sendJSON(res, 400, { error: { message: String(err?.message ?? err) } })
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[host] ${err?.stack ?? err}`)
    if (!res.headersSent) sendJSON(res, 500, { error: { message: String(err?.message ?? err) } })
    else res.destroy()
  })
})

const errors = await reload()
console.error(`[host] listening on ${BIND}:${PORT} with ${loaded.size} provider(s); data ${DIR}`)
if (errors.length) console.error(`[host] packages that failed to load: ${errors.map((e) => `${e.spec} (${e.error})`).join(", ")}`)

server.listen(PORT, BIND, () => {
  console.error(`[host] ready: http://${BIND}:${PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
