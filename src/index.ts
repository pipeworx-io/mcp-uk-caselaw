interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * UK case law — Find Case Law, The National Archives.
 *
 * Judgments and tribunal decisions of the courts of England & Wales, the UK
 * Supreme Court, and the Employment Appeal Tribunal. Keyless: the Atom search
 * feed at caselaw.nationalarchives.gov.uk/atom.xml serves search, and every
 * judgment publishes its full text as Akoma Ntoso XML at <slug>/data.xml.
 *
 * COVERAGE — this is not all UK case law, and a 0-row result must never read
 * as "no such case":
 *  - No Crown Court, County Court or Magistrates' Court judgments — those are
 *    mostly given orally and never transcribed, so Find Case Law structurally
 *    cannot hold them.
 *  - No dockets, pleadings or filings — this is judgments only, there is no UK
 *    equivalent of PACER here.
 *  - England & Wales and UK-wide tribunals/apex courts only. Scotland and
 *    Northern Ireland's own court systems are not covered (a case that also
 *    went through NI/Scottish courts may still appear only for its UK Supreme
 *    Court or Privy Council leg).
 *  - Employment Appeal Tribunal (EAT) only — the first-tier Employment
 *    Tribunal (claims before they reach appeal) is a different, uncovered
 *    corpus; see the separate uk-tribunals pack/task for that.
 *  - No citator/treatment data — a judgment is returned as published, with no
 *    signal on whether it was later overturned, doubted or followed.
 *  - Coverage is mostly 2001 onward; earlier judgments exist unevenly at best.
 *
 * LICENCE — Find Case Law's Open Justice Licence covers per-query pass-through
 * (a caller searches, we relay one answer) but excludes "computational
 * analysis": bulk programmatic extraction or mirroring/indexing the corpus
 * requires a separate licence Pipeworx does not hold. Do not build a mirror
 * from this pack.
 *
 * Probed live 2026-08-11 and again 2026-09-18, because several of these will
 * bite anyone who guesses:
 *  - An INVALID `order` value returns zero entries rather than an error, so a
 *    typo'd sort reads as "no such cases". Orders are validated here instead of
 *    passed through.
 *  - Passing `order` WITHOUT `per_page` silently drops the page from 50 to 10,
 *    so per_page is always sent explicitly.
 *  - `court` is validated against COURTS *before* the fetch — Find Case Law
 *    answers an unrecognised code with a bare HTTP 400, and prior to 09-18
 *    that leaked to the caller as a raw upstream error including the request
 *    URL. It is now rejected up front as `invalid_arguments`, naming the code
 *    and the valid list, and the same mapping catches a code that passes our
 *    own list but still 400s upstream (COURTS can drift; see the Employment
 *    Appeal Tribunal note below).
 *  - The Employment Appeal Tribunal's real code is `eat`, not the "ukeat" the
 *    name would suggest — shipped wrong until 09-18, when `list_uk_courts`
 *    itself was verified to be handing out a code that always 400s. Every
 *    code in COURTS is now one this file has probed live and confirmed
 *    returns entries.
 * The date filters do bite, and the court filter is a real filter rather than a
 * silently ignored one — both verified rather than assumed.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'UK Caselaw');
}


const BASE = 'https://caselaw.nationalarchives.gov.uk';
// The service 403s a bare fetch signature; a browser UA is enough.
const UA = 'Mozilla/5.0 (compatible; Pipeworx/1.0; +https://pipeworx.io)';

const ORDERS: Record<string, string> = {
  newest: '-date',
  oldest: 'date',
  relevance: 'relevance',
};

/** Court codes are not guessable from a court's name, so they ship as data. */
const COURTS: { code: string; name: string }[] = [
  { code: 'uksc', name: 'United Kingdom Supreme Court' },
  { code: 'ukpc', name: 'Judicial Committee of the Privy Council' },
  { code: 'ewca/civ', name: 'Court of Appeal (Civil Division)' },
  { code: 'ewca/crim', name: 'Court of Appeal (Criminal Division)' },
  { code: 'ewhc/admin', name: 'High Court (Administrative Court)' },
  { code: 'ewhc/ch', name: 'High Court (Chancery Division)' },
  { code: 'ewhc/comm', name: 'High Court (Commercial Court)' },
  { code: 'ewhc/fam', name: 'High Court (Family Division)' },
  { code: 'ewhc/kb', name: "High Court (King's Bench Division)" },
  { code: 'ewhc/pat', name: 'High Court (Patents Court)' },
  { code: 'ewhc/tcc', name: 'High Court (Technology and Construction Court)' },
  { code: 'ewhc/ipec', name: 'Intellectual Property Enterprise Court' },
  { code: 'ewcop', name: 'Court of Protection' },
  { code: 'ewfc', name: 'Family Court' },
  { code: 'ukut/aac', name: 'Upper Tribunal (Administrative Appeals Chamber)' },
  { code: 'ukut/iac', name: 'Upper Tribunal (Immigration and Asylum Chamber)' },
  { code: 'ukut/lc', name: 'Upper Tribunal (Lands Chamber)' },
  { code: 'ukut/tcc', name: 'Upper Tribunal (Tax and Chancery Chamber)' },
  { code: 'ukftt/grc', name: 'First-tier Tribunal (General Regulatory Chamber)' },
  { code: 'ukftt/tc', name: 'First-tier Tribunal (Tax Chamber)' },
  // Find Case Law's real code is "eat", not "ukeat" — verified live 09-18;
  // "ukeat" 400s on every request. This is the EAT (appeals) only, not the
  // first-tier Employment Tribunal.
  { code: 'eat', name: 'Employment Appeal Tribunal' },
];

const COURT_CODES = new Set(COURTS.map((c) => c.code));

const tools: McpToolExport['tools'] = [
  {
    name: 'search_uk_caselaw',
    description:
      'Search UK court judgments and tribunal decisions by subject, party name or judge — the Supreme Court, Court of Appeal, High Court, Court of Protection, Family Court, Employment Appeal Tribunal and the other UK tribunals, from The National Archives\' Find Case Law. Returns the case name, the NEUTRAL CITATION ("[2026] EWHC 1996 (Comm)"), the court, the judgment date and a link, plus the identifier get_uk_judgment reads to fetch the full text. Use this for England & Wales and UK-wide law. NOT ALL UK LAW: no Crown/County/Magistrates\' Court judgments (given orally, never transcribed), no dockets/pleadings/filings, Scotland and Northern Ireland\'s own court systems are not covered, the first-tier Employment Tribunal is not covered (EAT appeals only), there is no citator/treatment signal, and coverage is mostly 2001 onward — a 0-row result means "not found here", not "does not exist". Per-query pass-through only, one judgment at a time: Find Case Law\'s Open Justice Licence excludes bulk or computational extraction across its records. US case law is a different corpus entirely — search_case_law and find_case cover that, and returning a US authority for a UK question is a wrong answer, not a near miss.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search over the judgment text, e.g. "unjust enrichment" or "vicarious liability".' },
        court: { type: 'string', description: 'Court code to narrow to, e.g. "uksc", "ewca/civ", "ewhc/comm". Call list_uk_courts for the codes — they are not guessable from a court name.' },
        party: { type: 'string', description: 'Party name to match, e.g. "Tesco".' },
        judge: { type: 'string', description: 'Judge name to match.' },
        from_date: { type: 'string', description: 'Earliest judgment date, YYYY-MM-DD.' },
        to_date: { type: 'string', description: 'Latest judgment date, YYYY-MM-DD.' },
        order: { type: 'string', description: 'newest (default) | oldest | relevance.' },
        limit: { type: 'number', description: 'Judgments to return, 1-50 (default 20).' },
      },
    },
  },
  {
    name: 'get_uk_judgment',
    description:
      'Fetch the FULL TEXT of a UK judgment from its neutral citation ("[2023] UKSC 42", "[2026] EWHC 1996 (Comm)") or its Find Case Law identifier. Returns the judgment text along with the case name, court, date and citation, so a quoted passage or a cited authority can actually be checked against what the court wrote rather than taken on trust. Text is long; use max_chars to bound it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: { type: 'string', description: 'Neutral citation, e.g. "[2023] UKSC 42", or a Find Case Law identifier like "uksc/2023/42".' },
        max_chars: { type: 'number', description: 'Maximum characters of judgment text to return (default 40000). The response says whether it was truncated.' },
      },
      required: ['citation'],
    },
  },
  {
    name: 'list_uk_courts',
    description:
      'List the UK courts and tribunals covered by Find Case Law with the court code each one uses. Call this before narrowing search_uk_caselaw by court — a code like "ewhc/comm" cannot be guessed from "Commercial Court". Every code here has been probed live against the atom feed; an unlisted code is rejected as invalid_arguments rather than sent upstream.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function fcl(path: string): Promise<string> {
  const res = await pwFetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/xml' } });
  if (!res.ok) throw new Error(`Find Case Law returned HTTP ${res.status} for ${path}`);
  return res.text();
}

function attr(fragment: string, name: string): string | null {
  const m = fragment.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function tag(fragment: string, name: string): string | null {
  const m = fragment.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

function unescapeXml(s: string): string {
  return s
    // Judgments are full of curly quotes and dashes encoded numerically; leaving
    // them raw puts "&#8220;" in the middle of a quoted passage someone is trying
    // to verify against the court's words.
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

interface Judgment {
  case_name: string | null;
  neutral_citation: string | null;
  identifier: string | null;
  court: string | null;
  judgment_date: string | null;
  url: string | null;
  pdf_url: string | null;
}

function parseEntry(entry: string): Judgment {
  const ncn = entry.match(/<tna:identifier slug="([^"]+)" type="ukncn">([^<]*)</);
  const links = [...entry.matchAll(/<link ([^>]+)\/?>/g)].map((m) => m[1]);
  const pdf = links.find((l) => l.includes('application/pdf'));
  const alt = links.find((l) => !l.includes('type=') && l.includes('rel="alternate"'));
  return {
    case_name: unescapeXml(tag(entry, 'title') ?? ''),
    neutral_citation: ncn ? unescapeXml(ncn[2]) : null,
    identifier: ncn ? ncn[1] : null,
    court: unescapeXml(tag(entry, 'name') ?? ''),
    judgment_date: (tag(entry, 'published') ?? '').slice(0, 10) || null,
    url: alt ? attr(alt, 'href') : null,
    pdf_url: pdf ? attr(pdf, 'href') : null,
  };
}

function ymd(value: unknown, field: string): { d: string; m: string; y: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`${field} must be YYYY-MM-DD, got "${value}"`);
  return { y: m[1], m: m[2], d: m[3] };
}

async function searchUkCaselaw(args: Record<string, unknown>) {
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
  const orderArg = typeof args.order === 'string' ? args.order.trim().toLowerCase() : 'newest';
  const order = ORDERS[orderArg];
  // An unrecognised order returns an EMPTY feed upstream, which would read as
  // "no such judgments". Refuse it here so the caller sees the real problem.
  if (!order) {
    throw new Error(`order must be one of: ${Object.keys(ORDERS).join(', ')}. Got "${orderArg}".`);
  }

  const p = new URLSearchParams();
  for (const [key, arg] of [['query', 'query'], ['party', 'party'], ['judge', 'judge']] as const) {
    const v = args[arg];
    if (typeof v === 'string' && v.trim()) p.set(key, v.trim());
  }
  const court = typeof args.court === 'string' ? args.court.trim().toLowerCase() : '';
  // Validated BEFORE the fetch, not caught after: Find Case Law answers an
  // unrecognised court with a bare HTTP 400, and letting that reach fcl()
  // would surface as a raw upstream failure blaming us for a fixable
  // argument. `user_error:` is the routing token the gateway strips and
  // classifies as `invalid_arguments` for the caller.
  if (court && !COURT_CODES.has(court)) {
    throw new Error(
      `user_error: "${court}" is not a valid Find Case Law court code. Call list_uk_courts for the valid codes. Valid codes: ${[...COURT_CODES].join(', ')}.`,
    );
  }
  if (court) p.set('court', court);
  const from = ymd(args.from_date, 'from_date');
  if (from) { p.set('from_date_0', from.d); p.set('from_date_1', from.m); p.set('from_date_2', from.y); }
  const to = ymd(args.to_date, 'to_date');
  if (to) { p.set('to_date_0', to.d); p.set('to_date_1', to.m); p.set('to_date_2', to.y); }
  p.set('order', order);
  // Always explicit: sending `order` without `per_page` silently caps the feed at 10.
  p.set('per_page', String(limit));

  if (![...p.keys()].some((k) => ['query', 'party', 'judge', 'court'].includes(k))) {
    throw new Error('Give at least one of query, party, judge or court — Find Case Law will otherwise return simply the most recent judgments, which is rarely what was meant.');
  }

  let xml: string;
  try {
    xml = await fcl(`/atom.xml?${p}`);
  } catch (err) {
    // `court` is already validated against COURTS above, so a 400 reaching
    // here means COURTS itself has drifted (a code that used to work upstream
    // stopped, the way "ukeat" did) — a Pipeworx-side defect, not a caller
    // mistake. Named explicitly rather than left as a raw URL in the error.
    if (court && /HTTP 400/.test(String(err))) {
      throw new Error(
        `Find Case Law rejected court code "${court}" with HTTP 400 even though it is in our own court list — the upstream code may have changed. This is a Pipeworx-side bug, not a bad argument; please report it. Try search_uk_caselaw without the court filter in the meantime.`,
      );
    }
    throw err;
  }
  const judgments = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => parseEntry(m[0]));

  if (!judgments.length) {
    // `court` is validated above, so a genuinely bad code never reaches here —
    // an empty result at this point means no judgment matched, not that the
    // case doesn't exist. Find Case Law is not all UK law (see the file
    // header): Crown/County/Magistrates' judgments, dockets/filings, Scotland
    // and Northern Ireland's own courts, and the first-tier Employment
    // Tribunal are all outside this corpus regardless of how the query is
    // phrased.
    return {
      found: false,
      reason: 'no_matching_judgments',
      query: args.query ?? null,
      court: court || null,
      hint: 'No judgment matched in Find Case Law. This does not mean the case does not exist: Find Case Law indexes only written judgments of England & Wales courts, the UK Supreme Court and the Employment Appeal Tribunal from roughly 2001 onward — it holds no Crown/County/Magistrates\' Court decisions, no Scotland/Northern Ireland cases, and no first-tier Employment Tribunal decisions. Find Case Law indexes the full judgment text, so a phrase from the judgment works better than a legal concept the court never names; widening the date range or dropping the court filter is the usual next step.',
    };
  }

  return { found: true, query: args.query ?? null, court: court || null, order: orderArg, returned: judgments.length, judgments };
}

/**
 * Neutral citations map onto Find Case Law paths by rule — "[2026] EWHC 1996
 * (Comm)" is ewhc/comm/2026/1996 — but the rule is only a good first guess, so
 * a derived path that 404s falls back to searching the citation text and taking
 * an exact match. Guessing alone would quietly return the wrong judgment or a
 * bare 404 for a citation that is perfectly real.
 */
function citationToPath(citation: string): string | null {
  const c = citation.trim().replace(/\s+/g, ' ');
  const direct = c.match(/^([a-z]+(?:\/[a-z]+)?)\/(\d{4})\/(\d+)$/i);
  if (direct) return `${direct[1].toLowerCase()}/${direct[2]}/${direct[3]}`;

  const m = c.match(/^\[?(\d{4})\]?\s+([A-Za-z]+)\s*([A-Za-z]+)?\s*(\d+)\s*(?:\(([^)]+)\))?$/);
  if (!m) return null;
  const [, year, court, wordDiv, num, parenDiv] = m;
  const div = (parenDiv || wordDiv || '').trim().toLowerCase();
  return div ? `${court.toLowerCase()}/${div}/${year}/${num}` : `${court.toLowerCase()}/${year}/${num}`;
}

function judgmentText(xml: string): string {
  // Strip styling and metadata before extracting text: the Akoma Ntoso payload
  // embeds a CSS block, and a naive tag-strip returns font rules as judgment prose.
  const body = xml
    .replace(/<(?:akn:)?meta[\s\S]*?<\/(?:akn:)?meta>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return unescapeXml(body.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

async function getUkJudgment(args: Record<string, unknown>) {
  const citation = String(args.citation ?? '').trim();
  if (!citation) throw new Error('citation is required');
  const maxChars = Math.min(200_000, Math.max(1000, Number(args.max_chars) || 40_000));

  let path = citationToPath(citation);
  let xml: string | null = null;
  let resolvedBy = 'citation_pattern';

  if (path) {
    try {
      xml = await fcl(`/${path}/data.xml`);
    } catch {
      xml = null;
    }
  }

  // Fall back to search so a real citation the pattern mis-derives still resolves.
  if (!xml) {
    const feed = await fcl(`/atom.xml?query=${encodeURIComponent(citation)}&per_page=20&order=-date`);
    const entries = [...feed.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => parseEntry(m[0]));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = entries.find((e) => e.neutral_citation && norm(e.neutral_citation) === norm(citation));
    if (!hit?.identifier) {
      return {
        found: false,
        reason: 'citation_not_found',
        citation,
        attempted_path: path,
        hint: 'No judgment carries that neutral citation on Find Case Law. Check the year, court abbreviation and number; note the service covers judgments published by the courts from 2001 onward for some courts and much later for others, so an older authority may simply not be held. search_uk_caselaw by party or subject will find the citation if the case is there.',
      };
    }
    path = hit.identifier;
    xml = await fcl(`/${path}/data.xml`);
    resolvedBy = 'citation_search';
  }

  const text = judgmentText(xml);
  return {
    found: true,
    citation_requested: citation,
    identifier: path,
    resolved_by: resolvedBy,
    url: `${BASE}/${path}`,
    neutral_citation: tag(xml, 'uk:cite'),
    case_name: attr(xml.match(/<FRBRname[^>]*>/)?.[0] ?? '', 'value'),
    court: tag(xml, 'uk:court'),
    judgment_date: attr(xml.match(/<FRBRdate[^>]*name="judgment"[^>]*>/)?.[0] ?? '', 'date'),
    text_chars: text.length,
    truncated: text.length > maxChars,
    text: text.slice(0, maxChars),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_uk_caselaw':
      return searchUkCaselaw(args);
    case 'get_uk_judgment':
      return getUkJudgment(args);
    case 'list_uk_courts':
      return { count: COURTS.length, courts: COURTS };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
