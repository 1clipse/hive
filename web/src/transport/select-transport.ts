// Decides which transport the bundle boots with. Consumed by M5b's mobile entry; the desktop entry
// never calls this (directTransport is the default in api.ts). M5a delivers the seam + default only.
export const isGatewayServedBundle = (): boolean => {
  // Safety fallback: gateway-served iff loaded over a non-loopback host. The local runtime binds
  // 127.0.0.1, so a loopback origin can never be the gateway bundle.
  const host = window.location.hostname
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
    return false
  }
  // Authoritative for non-loopback origins: a build flag CI sets on the gateway-uploaded bundle.
  if (import.meta.env.VITE_HIVE_GATEWAY_BUNDLE === '1') return true
  return true
}
