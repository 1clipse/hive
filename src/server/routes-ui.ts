import { ForbiddenError } from './http-errors.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const uiRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/session', ({ request, response, store }) => {
    // HARDEN (defense in depth, layer 3): this route mints the master
    // hive_ui_token cookie, the single credential for every /api/* route + WS
    // upgrade. The bridge whitelist already hard-denies /api/ui/session, but if
    // that ever regresses, a tunnel-tagged request must STILL never mint a
    // cookie for a remote device. The tunnel is authorized by the per-boot
    // secret, so it has zero need for the UI cookie — refuse it outright.
    if (store.authorizeRemoteTunnelRequest(request)) {
      throw new ForbiddenError('UI session cookie is not available over the remote tunnel')
    }
    response.setHeader(
      'set-cookie',
      `hive_ui_token=${store.getUiToken()}; Path=/; HttpOnly; SameSite=Strict`
    )
    sendJson(response, 200, { ok: true })
  }),
]
