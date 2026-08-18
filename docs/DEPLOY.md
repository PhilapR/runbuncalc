# Deploying runbun to Cloudflare

The app ships as ONE Cloudflare Worker: `worker.js` gates every request, the
run/battle API answers in-process, and the committed `dist/` rides along as
the Worker's assets binding. There is no server to keep alive and no database
— a run lives in the player's browser and travels in the request body.

## The one-button path (recommended)

The **Deploy** GitHub Action (`.github/workflows/deploy.yml`) is the whole
ceremony. It is `workflow_dispatch` — deploying is a deliberate act, it never
fires on push.

1. Create the repository secrets (Settings → Secrets and variables → Actions):

   | Secret | Where it comes from |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template (scope: Account → Workers Scripts: Edit) |
   | `CLOUDFLARE_ACCOUNT_ID` | dashboard sidebar, "Account ID" |
   | `SITE_AUTH_PASSWORD` | you invent it — the preview gate's Basic-auth password |

   `SITE_AUTH_PASSWORD` is optional to the workflow but not to the site: a
   deploy without it comes up answering **503 to everything** (fail closed),
   never public. With it, the workflow pushes it as the Worker secret before
   deploying, so a fresh Worker is gated from its first request.

2. Actions tab → **Deploy** → Run workflow.

3. The first deploy prints the URL: `https://runbun.<account-subdomain>.workers.dev`.
   Open it, enter **any username** + the password (the gate compares only the
   password, as SHA-256 digests in constant time).

## The laptop path

```sh
npm install
npx wrangler login              # or export CLOUDFLARE_API_TOKEN
npx wrangler secret put SITE_AUTH_PASSWORD
npm run cf:deploy               # build + bundle + wrangler deploy
```

Local preview: `cp .dev.vars.example .dev.vars`, pick a line (password or
`PREVIEW_OPEN=true`), then `npm run cf:preview`.

## The gate, verified

`wrangler.jsonc` sets `run_worker_first: true` — without it Cloudflare answers
static paths from the assets binding BEFORE the Worker runs and the gate is
decorative. This table was measured against the real bundle (wrangler dev +
direct fetch), not read off the code:

| Configuration | `/` | static `/js/*` | API |
|---|---|---|---|
| No secret, no `PREVIEW_OPEN` | 503 | 503 | 503 |
| `SITE_AUTH_PASSWORD` set, no/wrong/malformed auth | 401 | 401 | 401 |
| `SITE_AUTH_PASSWORD` set, correct password | 200 | 200 | 200 |
| `PREVIEW_OPEN=true` (public on purpose) | 200 | 200 | 200 |

A malformed `Authorization` header (garbage base64) is a 401, not a 500 — the
gate never crashes open or crashes loud.

## Plan and cost

- **Workers Paid plan ($5/mo) is required.** `limits.cpu_ms = 30000` backs the
  advisor and ranker endpoints, which rebuild matchup rows for seconds, not
  milliseconds; the free tier's 10ms CPU ceiling would kill exactly those two
  answers. Everything else about the app fits free-tier limits comfortably.
- `run_worker_first` means every asset request invokes the Worker (that is the
  point — the gate sees it). Requests bill at Workers rates; at private-preview
  traffic this is noise.
- Observability is on in `wrangler.jsonc`; live logs via
  `npx wrangler tail runbun`.

## Public day / custom domain

Both are one edit in `wrangler.jsonc`, done on purpose:

- **Public:** set the `PREVIEW_OPEN=true` var (dashboard → Worker → Settings →
  Variables, or `[vars]` in config). The gate steps aside explicitly; deleting
  the password secret alone does NOT open the site — it 503s.
- **Custom domain:** swap `"workers_dev": true` for the zone route kept in the
  config comment (`runbun.stochastic-inference.dev` on the fleet's zone).

## Rotating the password

`printf '%s' 'new-password' | npx wrangler secret put SITE_AUTH_PASSWORD`
(or update the repo secret and re-run Deploy). Takes effect on the next
request; browsers re-prompt on the 401.
