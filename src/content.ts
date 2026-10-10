import type { ProxyRequest, ProxyResponse } from './types'

const EVT_READY = 'cors-bypass:ready'
const EVT_STATE = 'cors-bypass:state'
const EVT_REQUEST = 'cors-bypass:request'
const EVT_RESPONSE = 'cors-bypass:response'

let lastState: boolean | null = null

function sendState(enabled: boolean) {
  lastState = enabled
  window.dispatchEvent(new CustomEvent(EVT_STATE, { detail: { enabled } }))
}

async function pushState() {
  try {
    const { enabled } = await browser.storage.local.get('enabled')
    sendState(enabled === true)
  } catch {
    return
  }
}

void pushState()

window.addEventListener(EVT_READY, () => {
  if (lastState !== null) sendState(lastState)
  else void pushState()
})

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) sendState(changes.enabled.newValue === true)
})

window.addEventListener(EVT_REQUEST, (event) => {
  const detail = (event as CustomEvent<{ id: string; request: ProxyRequest }>).detail
  if (!detail || typeof detail.id !== 'string') return
  void handleRequest(detail.id, detail.request)
})

async function handleRequest(id: string, request: ProxyRequest) {
  const spoofed: ProxyRequest = {
    ...request,
    pageOrigin: location.origin,
    pageUrl: location.href,
  }
  let response: ProxyResponse
  try {
    response = await browser.runtime.sendMessage({ type: 'cors-bypass-fetch', payload: spoofed })
  } catch (e) {
    response = { error: e instanceof Error ? e.message : String(e) }
  }
  window.dispatchEvent(new CustomEvent(EVT_RESPONSE, { detail: { id, response } }))
}
