export type BodyPayload =
  | { kind: 'string'; data: string }
  | { kind: 'base64'; data: string }

export type ProxyRequest = {
  url: string
  method: string
  headers: [string, string][]
  body: BodyPayload | null
  credentials: RequestCredentials
  pageOrigin?: string
  pageUrl?: string
}

export type ProxySuccess = {
  url: string
  status: number
  statusText: string
  headers: [string, string][]
  body: { kind: 'base64'; data: string }
}

export type ProxyResponse = ProxySuccess | { error: string }
