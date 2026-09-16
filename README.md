# UK Case Law — Find Case Law

Judgments and tribunal decisions of the UK courts, from The National Archives'
Find Case Law service: the Supreme Court, Privy Council, Court of Appeal, High
Court, Court of Protection, Family Court, the Upper and First-tier Tribunals and
the Employment Appeal Tribunal.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

Search by subject, party or judge, then read the **full text** of any judgment
from its neutral citation — so a quoted passage or a cited authority can be
checked against what the court actually wrote.

This is UK law only. US case law is a separate corpus served by `court-listener`
(`search_case_law`, `find_case`, `get_opinion`); an American authority returned
for a UK question is a wrong answer, not a near miss.

## Auth

**None.** No key, no signup. Requests carry a browser User-Agent because the
service rejects a bare fetch signature.

## Tools

| Tool | Use it when |
|---|---|
| `search_uk_caselaw` | You know the **subject, party or judge** — "unjust enrichment", "Tesco" |
| `get_uk_judgment` | You have a **neutral citation** — `[2023] UKSC 42` — and want the text |
| `list_uk_courts` | You want to narrow by court and need the code |

The usual path is `search_uk_caselaw` → take the `neutral_citation` or
`identifier` → `get_uk_judgment`.

## Neutral citations

A neutral citation maps onto a Find Case Law path by rule — `[2026] EWHC 1996
(Comm)` is `ewhc/comm/2026/1996`, `[2023] UKSC 42` is `uksc/2023/42`. The rule is
a good first guess, so `get_uk_judgment` tries it and falls back to searching the
citation text when the derived path 404s, reporting which route resolved it in
`resolved_by`. Either form is accepted as input.

## Data sources

- Search: `https://caselaw.nationalarchives.gov.uk/atom.xml` (Atom feed)
- Judgment text: `https://caselaw.nationalarchives.gov.uk/<identifier>/data.xml`
  ([Akoma Ntoso](http://www.akomantoso.org/) XML)
- Service: <https://caselaw.nationalarchives.gov.uk/>

Judgments are Crown copyright, published under the
[Open Justice Licence](https://caselaw.nationalarchives.gov.uk/open-justice-licence).

## Caveats worth passing to a user

- **Coverage starts recently.** Find Case Law holds judgments the courts
  published to it — comprehensively from 2003 for some courts and much later for
  others. A missing older authority means *not held here*, not *no such case*.
  For historic authority a law-report subscription is still the answer.
- **An unrecognised court code is rejected, not ignored.** `search_uk_caselaw`
  returns `unknown_court_code` and points at `list_uk_courts`. Codes look like
  `uksc`, `ewca/civ`, `ewhc/comm` and cannot be guessed from a court's name.
- **Search is over the judgment text**, so a phrase the court would actually
  write finds more than a legal concept it never names.
- **Judgments are long** — 140k–450k characters is ordinary. `get_uk_judgment`
  bounds the response with `max_chars` and sets `truncated` so a cut-off text is
  never mistaken for the whole judgment.
- **Only `newest`, `oldest` and `relevance` sort.** Upstream answers an
  unrecognised sort with an empty feed, which would read as "no such cases", so
  the pack rejects one instead of passing it through.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "uk-caselaw": {
      "url": "https://gateway.pipeworx.io/uk-caselaw/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/uk-caselaw/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "uk-caselaw": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-uk-caselaw"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-uk-caselaw
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Uk Caselaw data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
