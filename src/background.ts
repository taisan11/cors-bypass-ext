import type { ProxyRequest, ProxyResponse } from './types'

const RULE_ID = 1

const RESOURCE_TYPES: browser.declarativeNetRequest.ResourceType[] = [
  'xmlhttprequest',
  'script',
  'stylesheet',
  'image',
  'media',
  'font',
  'ping',
  'other',
]

const CORS_RESPONSE_HEADERS: browser.declarativeNetRequest._RuleActionResponseHeaders[] = [
  { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
  { header: 'Access-Control-Allow-Methods', operation: 'set', value: '*' },
  { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
  { header: 'Access-Control-Allow-Private-Network', operation: 'set', value: 'true' },
]

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

async function applyState(enabled: boolean) {
  await browser.action.setBadgeText({ text: enabled ? 'ON' : '' })
  await browser.action.setBadgeBackgroundColor({ color: '#16a34a' })
  if (enabled) {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          condition: { regexFilter: '.*', resourceTypes: RESOURCE_TYPES },
          action: { type: 'modifyHeaders', responseHeaders: CORS_RESPONSE_HEADERS },
        },
      ],
    })
  } else {
  lastSpoof = { targetOrigin: '', targetHref: '' }
    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] })
    await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [SPOOF_RULE_ID] })
  }
}

const SPOOF_RULE_ID = 2

let lastSpoof = { targetOrigin: '', targetHref: '' }

async function updateSpoofRule(req: ProxyRequest) {
  const target = new URL(req.url)
  const targetOrigin = target.origin
  const targetHref = target.href
  if (!targetOrigin || targetOrigin === 'null') return
  if (lastSpoof.targetOrigin === targetOrigin && lastSpoof.targetHref === targetHref) return
  lastSpoof = { targetOrigin, targetHref }
  const headerSets: browser.declarativeNetRequest._RuleActionRequestHeaders[][] = [
    [
      { header: 'Origin', operation: 'set', value: targetOrigin },
      { header: 'Referer', operation: 'set', value: targetHref },
      { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
      { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
      { header: 'Sec-Fetch-Dest', operation: 'set', value: 'empty' },
    ],
    [
      { header: 'Origin', operation: 'set', value: targetOrigin },
      { header: 'Referer', operation: 'set', value: targetHref },
    ],
  ]
  for (const requestHeaders of headerSets) {
    const rule = {
      id: SPOOF_RULE_ID,
      priority: 1,
      condition: { tabIds: [-1], resourceTypes: RESOURCE_TYPES },
      action: { type: 'modifyHeaders' as const, requestHeaders },
    }
    try {
      if (import.meta.env.IS_CHROME) {
        await browser.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [SPOOF_RULE_ID],
          addRules: [rule],
        })
      } else {
        await (browser.declarativeNetRequest.updateSessionRules as (options: unknown) => Promise<void>)({
          removeRuleIds: [SPOOF_RULE_ID],
          addOrExtendRules: [rule],
        })
      }
      return
    } catch {
      continue
    }
  }
    lastSpoof = { targetOrigin: '', targetHref: '' }
}

async function refresh() {
  const { enabled } = await browser.storage.local.get('enabled')
  await applyState(enabled === true)
}

browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.get('enabled').then(async ({ enabled }) => {
    if (enabled === undefined) await browser.storage.local.set({ enabled: false })
  })
})

void refresh()

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) void applyState(changes.enabled.newValue === true)
})

browser.runtime.onMessage.addListener(
  (message: any, _sender: unknown, sendResponse: (response: ProxyResponse) => void) => {
    if (message?.type !== 'cors-bypass-fetch') return
    void handleProxy(message.payload as ProxyRequest).then(sendResponse)
    return true
  },
)

async function handleProxy(req: ProxyRequest): Promise<ProxyResponse> {
  try {
    await updateSpoofRule(req)
    const headers = new Headers(req.headers)
    let body: BodyInit | undefined
    if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
      body = req.body.kind === 'string' ? req.body.data : (base64ToBytes(req.body.data) as BodyInit)
    }
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body,
      credentials: req.credentials,
    })
    const buffer = await res.arrayBuffer()
    return {
      url: res.url,
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body: { kind: 'base64', data: bytesToBase64(new Uint8Array(buffer)) },
    }
  } catch (e) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}
