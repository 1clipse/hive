interface ImportMetaEnv {
  readonly PROD: boolean
  readonly DEV: boolean
  readonly MODE: string
  /** CI sets this on the gateway-uploaded mobile bundle so it boots TunnelTransport. */
  readonly VITE_HIVE_GATEWAY_BUNDLE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}

declare module '*.jpeg' {
  const url: string
  export default url
}

declare module '*.jpg' {
  const url: string
  export default url
}
