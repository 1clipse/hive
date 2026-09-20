// Shared chrome for every server-rendered gateway page (login / machines / pair / approve / legal).
// These are the only HTML the gateway serves itself — the rich app is the /app bundle — so they must
// still look like Hive, not a browser default. The styling lives in ONE stylesheet served same-origin
// at /styles.css (see pages.ts), linked here. That keeps the baseline CSP (default-src 'self', no
// 'unsafe-inline') intact: no inline <style>, no inline style="" attributes, no inline scripts, no
// third-party origins (system font stack + the same-origin /brand bird mark, zero external fetches).

// HTML escaper (attribute- and text-safe). One impl shared by every renderer so a crafted name/code
// can't inject markup anywhere.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Inline favicon — the bird logo (32px PNG, same asset as the app's /logo.png). Inline data: URI
// so no external fetch and the CSP default-src 'self' is not widened. theme-color matches the
// app's --bg-0 (#171717) so the browser chrome blends into the same surface the user lands in.
import { BRAND_ICON_32_B64 } from './brand-assets.js'

const FAVICON_PNG = `data:image/png;base64,${BRAND_ICON_32_B64}`

// The document shell: brand header + centered card column + footer, all driven by /styles.css.
// `body` is the page-specific markup (already escaped by the caller). No inline scripts/styles.
// `opts.hero` drops the small header — hero pages (login) carry the brand inside the card instead,
// so the bird never appears twice on one screen.
export function renderShell(title: string, body: string, opts?: { hero?: boolean }): string {
  const header = opts?.hero
    ? ''
    : `<header class="brand"><img class="brand__mark" src="/brand/icon-192.png" width="22" height="22" alt=""><span class="brand__name">Hive</span></header>\n`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#171717">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="${FAVICON_PNG}">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="page">
${header}<main class="card">${body}</main>
<footer class="foot"><a href="/privacy">Privacy</a><span class="foot__dot" aria-hidden="true">·</span><a href="/terms">Terms</a></footer>
</div>
</body>
</html>`
}

// Served verbatim at /styles.css with a long cache + text/css. Dark-only, and deliberately the SAME
// palette as the app these pages funnel into (charcoal #171717 surfaces, Twenty-blue accent, the
// blue bird as the only brand mark) — sign-in → machines → pair → /app should read as one product,
// no palette jump at the door. Mobile-first: 48px touch targets, safe-area padding, no hover-only
// affordances.
export const PAGE_STYLES = `:root{
  --bg:#171717; --bg2:#1b1b1b; --card:#1d1d1d; --card2:#222222;
  --border:#2a2a2a; --border2:#3a3a3a;
  --text:#ebebeb; --muted:#b3b3b3; --faint:#6f6f6f;
  --accent:#3358d4; --accent-hover:#5072dd; --accent-ink:#ffffff;
  --accent-soft:rgba(51,88,212,.13); --accent-line:rgba(80,114,221,.34); --accent-text:#aebfee;
  --green:#54a271; --red:#d4544f;
  --radius:14px; --radius-sm:10px;
  --shadow:0 16px 44px -18px rgba(0,0,0,.6);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html{color-scheme:dark}
html,body{margin:0;padding:0}
body{
  min-height:100vh;min-height:100dvh;font-family:var(--font);color:var(--text);
  background:radial-gradient(820px 460px at 50% -120px,rgba(51,88,212,.13),transparent 62%) no-repeat,var(--bg);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-height:1.5;
}
a{color:var(--accent-hover);text-decoration:none}
a:hover{text-decoration:underline}
.page{
  min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
  padding:max(28px,env(safe-area-inset-top,0px)) 16px max(28px,env(safe-area-inset-bottom,0px));
}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;letter-spacing:.1px}
.brand__name{font-size:17px}
.brand__mark{width:22px;height:22px;display:inline-block}
.card{
  width:100%;max-width:400px;background:var(--card);
  border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);
  padding:28px 24px;
}
.card--wide{max-width:560px}
.hero{display:flex;flex-direction:column;align-items:center;gap:4px;margin:8px 0 24px;text-align:center}
.hero__mark{width:64px;height:64px;margin-bottom:8px;filter:drop-shadow(0 8px 28px rgba(51,88,212,.38))}
.hero__name{margin:0;font-size:24px;font-weight:680;letter-spacing:-.3px}
.hero__tag{margin:0;color:var(--muted);font-size:14px}
h1{margin:0 0 6px;font-size:20px;font-weight:650;letter-spacing:-.2px}
.sub{margin:0 0 20px;color:var(--muted);font-size:14px}
p{margin:0 0 14px}
.btn{
  display:flex;align-items:center;justify-content:center;gap:9px;width:100%;min-height:48px;
  padding:12px 16px;border-radius:var(--radius-sm);border:1px solid var(--border2);
  background:var(--card2);color:var(--text);font:inherit;font-weight:560;font-size:15px;
  cursor:pointer;transition:border-color .15s,background .15s,transform .05s;text-decoration:none;
  -webkit-tap-highlight-color:transparent;
}
.btn+.btn{margin-top:10px}
.btn:hover{border-color:#4a4a4a;background:#262626;text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn--primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:620}
.btn--primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn:focus-visible{outline:2px solid var(--accent-hover);outline-offset:2px}
.ico{width:18px;height:18px;flex:0 0 auto;fill:currentColor}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.row{
  display:flex;align-items:center;gap:12px;min-height:54px;padding:12px 14px;
  border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card2);
}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--faint)}
.dot--on{background:var(--green);box-shadow:0 0 0 3px rgba(84,162,113,.18)}
.dot--off{background:var(--faint)}
.dot--bad{background:var(--red);box-shadow:0 0 0 3px rgba(212,84,79,.16)}
.row__main{min-width:0;flex:1}
.row__name{display:block;font-weight:570;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row__meta{display:block;color:var(--faint);font-size:12.5px;margin-top:2px}
.empty{color:var(--faint);font-size:13.5px;padding:10px 2px}
.sect{margin-top:22px}
.sect:first-child{margin-top:0}
.sect__h{font-size:11px;text-transform:uppercase;letter-spacing:.8px;font-weight:650;color:var(--faint);margin:0 0 8px}
.steps{list-style:none;counter-reset:step;margin:0 0 20px;padding:0;display:flex;flex-direction:column;gap:12px}
.steps li{position:relative;padding-left:34px;color:var(--muted);font-size:14px;line-height:1.55}
.steps li::before{
  counter-increment:step;content:counter(step);
  position:absolute;left:0;top:0;width:23px;height:23px;
  display:flex;align-items:center;justify-content:center;
  border-radius:8px;background:var(--accent-soft);border:1px solid var(--accent-line);
  color:var(--accent-text);font-size:12px;font-weight:650;
}
.steps strong{color:var(--text);font-weight:600}
.code{font-family:var(--mono);font-size:13px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:2px 7px;word-break:break-all;color:var(--text)}
.codeblock{display:block;font-family:var(--mono);font-size:13px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin:0 0 18px;word-break:break-all;color:var(--text)}
.note{
  display:flex;gap:10px;padding:12px 14px;border-radius:var(--radius-sm);
  background:var(--accent-soft);border:1px solid var(--accent-line);
  color:var(--accent-text);font-size:13px;line-height:1.55;margin:0 0 20px;
}
.divider{height:1px;background:var(--border);margin:22px 0 18px}
.muted{color:var(--muted)}
.actions{display:flex;gap:10px;margin-top:6px}
.actions .btn{margin-top:0}
.legal{font-size:14px;color:var(--muted)}
.legal h1{color:var(--text)}
.legal p{margin:0 0 12px}
.foot{display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12.5px}
.foot a{color:var(--faint)}
.foot a:hover{color:var(--muted)}
.foot__dot{color:var(--faint)}
.signout{margin-top:18px;text-align:center}
.signout .btn{width:auto;min-height:40px;padding:8px 18px;font-size:13px;color:var(--faint);background:none;border:none;cursor:pointer}
.signout .btn:hover{color:var(--muted);background:none;border:none}
.reason{font-size:13px;margin:0 0 16px}
@media (max-width:480px){.card{padding:24px 18px}.page{gap:16px}}
`
