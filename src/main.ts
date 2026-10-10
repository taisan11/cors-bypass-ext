import type { ProxyRequest, ProxySuccess } from './types'

const EVT_READY = 'cors-bypass:ready'
const EVT_STATE = 'cors-bypass:state'
const EVT_REQUEST = 'cors-bypass:request'
const EVT_RESPONSE = 'cors-bypass:response'

const pristineFetch = window.fetch
const nativeToString = Function.prototype.toString

let stateKnown = false
let enabled = false
const waiters: Array<() => void> = []

function applyVisibility(on: boolean) {
  window.fetch = on ? (patchedFetch as typeof window.fetch) : pristineFetch
  Object.defineProperty(Function.prototype, 'toString', {
    value: on
      ? function toString(this: Function) {
          if (this === patchedFetch) return nativeToString.call(pristineFetch)
          return nativeToString.call(this)
        }
      : nativeToString,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  if (on) {
    Object.defineProperty(window, 'cors_bypass', {
      value: {
        status: {
          get enabled() {
            return stateKnown && enabled
          },
          get ready() {
            return stateKnown
          },
        },
      },
      configurable: true,
    })
  } else {
    Reflect.deleteProperty(window, 'cors_bypass')
  }
}

function onState(value: boolean) {
  enabled = value
  const first = !stateKnown
  stateKnown = true
  if (first) for (const w of waiters.splice(0)) w()
  applyVisibility(enabled)
}

window.addEventListener(EVT_STATE, (event) => {
  const detail = (event as CustomEvent<{ enabled?: boolean }>).detail
  onState(detail?.enabled === true)
})
window.dispatchEvent(new CustomEvent(EVT_READY))

function waitForState(): Promise<void> {
  if (stateKnown) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(fn)
      if (i >= 0) waiters.splice(i, 1)
      if (!stateKnown) applyVisibility(false)
      resolve()
    }, 2000)
    const fn = () => {
      clearTimeout(timer)
      resolve()
    }
    waiters.push(fn)
  })
}

class FallbackError extends Error {}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

type Target = {
  url: URL
  method: string
  headers: Headers
  body: BodyInit | null
  credentials: RequestCredentials
  signal: AbortSignal | null | undefined
}

function shouldBypass(url: URL): boolean {
  if (url.origin === location.origin) return false
  return url.protocol === 'http:' || url.protocol === 'https:'
}

async function resolveTarget(input: RequestInfo | URL, init?: RequestInit): Promise<Target> {
  const req = input instanceof Request ? input : null
  const url = req ? new URL(req.url) : new URL(String(input), location.href)
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? req?.headers ?? [])
  const credentials = init?.credentials ?? req?.credentials ?? 'same-origin'
  const signal = init?.signal ?? req?.signal
  let body: BodyInit | null = null
  if (init?.body != null) {
    body = init.body
  } else if (req?.body != null && !req.bodyUsed) {
    body = await req.clone().arrayBuffer()
  }
  return { url, method, headers, body, credentials, signal }
}

type SerializedBody = {
  payload: import('./types').BodyPayload | null
  contentType?: string
}

async function serializeBody(body: BodyInit | null): Promise<SerializedBody> {
  if (body == null) return { payload: null }
  if (typeof body === 'string') return { payload: { kind: 'string', data: body } }
  if (body instanceof URLSearchParams) {
    return {
      payload: { kind: 'string', data: body.toString() },
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    }
  }
  if (body instanceof Blob) {
    return {
      payload: { kind: 'base64', data: bytesToBase64(new Uint8Array(await body.arrayBuffer())) },
      contentType: body.type || undefined,
    }
  }
  if (body instanceof ArrayBuffer) {
    return { payload: { kind: 'base64', data: bytesToBase64(new Uint8Array(body)) } }
  }
  if (ArrayBuffer.isView(body)) {
    return {
      payload: {
        kind: 'base64',
        data: bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      },
    }
  }
  if (body instanceof FormData) return serializeFormData(body)
  throw new FallbackError('unsupported body type')
}

async function serializeFormData(form: FormData): Promise<SerializedBody> {
  const boundary = '----CORSBypass' + Math.random().toString(36).slice(2)
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let size = 0
  const push = (text: string) => {
    const chunk = encoder.encode(text)
    chunks.push(chunk)
    size += chunk.length
  }
  for (const [name, value] of form.entries()) {
    push(`--${boundary}\r\n`)
    if (typeof value === 'string') {
      push(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    } else {
      push(
        `Content-Disposition: form-data; name="${name}"; filename="${value.name || 'blob'}"\r\n` +
          `Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
      )
      const chunk = new Uint8Array(await value.arrayBuffer())
      chunks.push(chunk)
      size += chunk.length
      push('\r\n')
    }
  }
  push(`--${boundary}--\r\n`)
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return {
    payload: { kind: 'base64', data: bytesToBase64(merged) },
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

let seq = 0

async function proxyFetch(target: Target): Promise<Response> {
  if (target.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  const { payload, contentType } = await serializeBody(target.body)
  const headers = [...target.headers.entries()]
  if (contentType && !target.headers.has('Content-Type')) headers.push(['Content-Type', contentType])
  const request: ProxyRequest = {
    url: target.url.href,
    method: target.method,
    headers,
    body: target.method === 'GET' || target.method === 'HEAD' ? null : payload,
    credentials: target.credentials,
  }
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`
  const response = await new Promise<import('./types').ProxyResponse>((resolve, reject) => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; response: import('./types').ProxyResponse }>)
        .detail
      if (!detail || detail.id !== id) return
      window.removeEventListener(EVT_RESPONSE, handler)
      resolve(detail.response)
    }
    window.addEventListener(EVT_RESPONSE, handler)
    window.dispatchEvent(new CustomEvent(EVT_REQUEST, { detail: { id, request } }))
    setTimeout(() => {
      window.removeEventListener(EVT_RESPONSE, handler)
      reject(new Error('CORS bypass proxy timed out'))
    }, 120000)
  })
  if ('error' in response) throw new Error(`CORS bypass proxy failed: ${response.error}`)
  return toResponse(response)
}

function toResponse(res: ProxySuccess): Response {
  const empty = res.status === 204 || res.status === 205 || res.status === 304
  const body = empty ? null : (base64ToBytes(res.body.data) as BodyInit)
  const response = new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
  Object.defineProperty(response, 'url', {
    value: res.url,
    writable: false,
    enumerable: true,
    configurable: true,
  })
  return response
}

async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  await waitForState()
  if (!enabled) return passThrough(input, init)
  try {
    const target = await resolveTarget(input, init)
    if (!shouldBypass(target.url)) return passThrough(input, init)
    return await proxyFetch(target)
  } catch (e) {
    if (e instanceof FallbackError) return passThrough(input, init)
    throw e
  }
}

function passThrough(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return Reflect.apply(pristineFetch, window, [input, init]) as Promise<Response>
}

Object.defineProperty(patchedFetch, 'name', { value: 'fetch', configurable: true })
Object.defineProperty(patchedFetch, 'toString', {
  value: () => nativeToString.call(pristineFetch),
  writable: true,
  enumerable: false,
  configurable: true,
})

window.fetch = patchedFetch as typeof window.fetch
