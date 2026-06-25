# Bartleby

Bartleby is a phone-callable ElevenLabs voice agent for talking through recent articles from *The Economist*. The goal is simple: call Bartleby, ask what is new in *The Economist*, and have a conversation grounded primarily in the current RSS feed.

This repository is intentionally standalone. It is modeled on the operating pattern of Andrew Furman's Phone Claw project, but it should not depend on Phone Claw code, configuration, or deployment state. Bartleby can consume Andrew's separate private Economist RSS server as a configured RSS source, but it should not import or duplicate that repository's subscriber-login/browser-fetch code.

Bartleby is not affiliated with, endorsed by, or sponsored by *The Economist*.

## Product Shape

- Call a phone number and talk to an ElevenLabs Conversational AI agent named Bartleby.
- Ask for the latest items across the feed, or narrow by *The Economist* section.
- Use RSS `category` tags as first-class section metadata when present, including sections such as `The World in Brief`, `The US in Brief`, `Leaders`, `United States`, `Business`, `Finance and Economics`, `Culture`, and `Obituary`.
- Fall back to conservative Economist URL/title section inference when public feeds omit category tags.
- Preload startup context for each call: latest U.S. in Brief if present, latest World in Brief if present, and up to 200 recent Economist RSS articles.
- Retrieve article text from the configured RSS feed when the feed provides it.
- Default to *The Economist* RSS feed for answers; use web search only when the caller explicitly asks for outside context or the feed clearly cannot answer.
- Keep private feed URLs, tokens, phone numbers, and provider credentials outside the public repository.

## Relationship To Phone Claw

Phone Claw provides the reference architecture:

- Twilio receives the phone call.
- A public webhook layer connects the call to ElevenLabs.
- ElevenLabs handles the live voice conversation and calls webhook tools.
- Tool endpoints fetch RSS data first and return compact voice-friendly results. Web search exists only as a narrow fallback for external context.

Bartleby narrows that model to one domain: *The Economist*. It should be smaller, cleaner, and more opinionated than Phone Claw. It should not expose general email, GitHub, Claude Code, or personal assistant tools unless they become explicitly relevant later.

## Implemented Architecture

```mermaid
flowchart LR
  Caller[Phone caller] --> Twilio[Twilio phone number]
  Twilio --> Webhook[Public webhook service]
  Webhook --> ElevenLabs[ElevenLabs Bartleby agent]
  ElevenLabs --> Tools[Bartleby tool endpoints]
  Tools --> RSS[Configured Economist RSS feed]
  Tools --> Search[Web search provider]
  Webhook --> D1[Cloudflare D1 call log]
  ElevenLabs --> PostCall[Post-call transcript webhook]
  PostCall --> D1
```

The public webhook service is a Cloudflare Worker, not Fastify. It is deployed at:

```text
https://bartleby.aifurman.workers.dev
```

The Worker handles Twilio inbound calls, Economist RSS tools, narrow outside web search, ElevenLabs post-call transcript logging, and password/token-protected admin transcript reads. Call and transcript data are stored in Cloudflare D1 only. No EC2 box, R2 bucket, S3-compatible object store, or separate private bridge is required for the initial scope.

## Core Tool Surface

The ElevenLabs agent should have a small, explicit tool set:

| Tool | Purpose |
| --- | --- |
| `economist_sections` | List known sections discovered from RSS `category` tags or inferred Economist URL/title sections. |
| `economist_recent` | Return recent feed entries, optionally filtered by section/category. |
| `economist_search` | Search recent feed entries by keyword, section, and date range. |
| `economist_article` | Retrieve the full text or longest available RSS text for a specific entry. |
| `economist_bootstrap` | Build startup context with the latest briefs and recent-article index. Used by the Twilio inbound webhook before the first agent turn. |
| `web_search` | Look up external background only when the caller asks for non-Economist context or the RSS feed clearly does not contain the answer. |

Tool responses should include stable entry IDs, title, URL, author when available, published date, section/category list, excerpt, and a short `answer_text` field that is safe for the voice agent to read aloud.

The agent should never use `web_search` merely because a question is current, broad, or complicated. It should first check the Economist RSS tools, answer from those articles when possible, and only then use search if the user requested outside information or the RSS result establishes a real gap.

## Call Logging

Bartleby logs into Cloudflare D1:

- Twilio inbound and status events
- caller/called numbers and allow-list decision
- ElevenLabs conversation ID
- transcript turns
- tool calls and tool results
- analysis summary
- metadata and conversation-initiation variables
- full transcript text

Admin reads are token protected:

```text
GET /admin/conversations
GET /admin/conversations/:conversation_id
GET /admin/calls/:twilio_call_sid
```

The Worker uses D1 for structured text logs only. It does not store audio blobs or raw webhook payload archives.

## RSS Feed Expectations

Bartleby should support one or more configured Economist RSS or Atom feeds. The real feed URL should be configured through environment variables or a host-local secret file, not committed.

For the best Economist coverage, point Bartleby at Andrew's private `economist-newspaper-rss-feed` server instead of the public Economist RSS feed. That service combines the public latest and section feeds, adds full-text subscriber article bodies when available, emits RSS `<category>` tags, and includes special authenticated handling for `The World in Brief`, which is not exposed as a normal dated item in the public RSS feeds.

Bartleby uses the private RSS server's category-filtering extension for section queries. Calls such as `economist_recent` or `economist_search` with `section: "United States"` fetch the feed with `category=United%20States`, then apply a local category fallback. Bartleby treats `The US in Brief` as separate from the standard `United States` section, even though the private feed tags U.S. brief entries with `United States` for RSS-reader discovery. It also keeps `Business` separate from `Finance and Economics`. This supports sections such as `Culture`, `Business`, `Finance and Economics`, `Leaders`, `Britain`, `Europe`, and `The World in Brief`.

Configure the private feed as:

```bash
ECONOMIST_RSS_URL=https://private.example.com/rss.xml
ECONOMIST_RSS_BEARER_TOKEN=replace-with-economist-feed-token
```

The private RSS server also supports `?token=...`, but `ECONOMIST_RSS_BEARER_TOKEN` keeps the token out of URLs and logs.

Example private config shape:

```json
{
  "feeds": [
    {
      "id": "economist",
      "title": "The Economist",
      "url": "https://example.com/private-economist-feed.xml?token=replace-me",
      "private": true,
      "cache_seconds": 900
    }
  ]
}
```

The parser should preserve:

- `title`
- `link` or canonical URL
- `guid` or feed ID
- `pubDate`, `published`, or `updated`
- `author` or `dc:creator`
- `category` tags as sections
- `description`, `summary`, `content`, or `content:encoded`

If a feed omits `category` tags, Bartleby derives a section from Economist URL paths such as `/leaders/`, `/united-states/`, `/finance-and-economics/`, and brief-style titles such as `The US in Brief`.

If the feed only includes an excerpt, Bartleby should say that clearly instead of implying full-text access.

## Agent Behavior

Bartleby should answer like an informed, concise reading companion:

- Prefer *The Economist* RSS feed over web search.
- Mention the article title and section when grounding an answer.
- Distinguish what the article says from outside context.
- Use web search only when the caller explicitly asks for outside information, newer developments beyond an article, background on a person/place/company not explained in the article, or when RSS tools return no relevant Economist material.
- Before using web search, try `economist_recent`, `economist_search`, or `economist_article` unless the caller has clearly asked for sources beyond *The Economist*.
- If the caller explicitly asks to search the web, use outside web context, or find information outside *The Economist*, call `web_search` before answering.
- Treat "web search", "outside web context", "outside The Economist", and "use the web search tool" as explicit external-search requests; do not name an outside source until `web_search` has returned results.
- When web search is used, state that the added context comes from outside *The Economist*.
- When the caller asks for more detail about a listed article, call `economist_article` immediately instead of asking whether to retrieve the full text.
- Say when the feed has no matching article or when only an excerpt is available.
- Keep spoken answers compact, then offer to go deeper.

## Configuration

Expected runtime secrets and config:

```bash
BARTLEBY_PUBLIC_BASE_URL=https://bartleby.aifurman.workers.dev
BARTLEBY_TOOL_TOKEN=
ADMIN_TOKEN=

ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_API_BASE=https://api.elevenlabs.io
ELEVENLABS_TELEPHONY_AUDIO_FORMAT=ulaw_8000
ELEVENLABS_VOICE_ID=onwK4e9ZLuTAKqWW03F9
ELEVENLABS_POST_CALL_WEBHOOK_ID=
ELEVENLABS_POST_CALL_TOKEN=
ELEVENLABS_WEBHOOK_SECRET=

TWILIO_PHONE_NUMBER=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_API_KEY_SID=
TWILIO_API_KEY_SECRET=
TWILIO_WEBHOOK_TOKEN=
ALLOWED_CALLER_NUMBERS=

ECONOMIST_RSS_URL=
ECONOMIST_RSS_BEARER_TOKEN=
ECONOMIST_RSS_CACHE_SECONDS=900
ECONOMIST_RSS_TIMEOUT_MS=25000
BARTLEBY_BOOTSTRAP_ARTICLE_LIMIT=200
BARTLEBY_BOOTSTRAP_MAX_CHARS=60000

WEB_SEARCH_PROVIDER=auto
TAVILY_API_KEY=
TAVILY_SEARCH_DEPTH=basic
```

The default `ELEVENLABS_VOICE_ID` is ElevenLabs' Daniel voice, a British male broadcaster-style voice. Override it with another available ElevenLabs voice ID if desired.

Do not commit `.env`, provider secrets, real phone numbers, subscriber RSS URLs, API keys, cookies, browser profiles, or exported configs that contain live operational identifiers.

## Local Commands

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
npm test
```

Deploy Worker:

```bash
npm run deploy
```

Apply D1 migrations:

```bash
npm run d1:migrate
```

Configure or create the ElevenLabs Bartleby agent and tools:

```bash
npm run elevenlabs:configure
```

Buy a new Twilio US local number or update an existing one:

```bash
TWILIO_PURCHASE_CONFIRM=true npm run twilio:provision
```

Run smoke checks:

```bash
npm run smoke:test
```

The smoke test verifies deployed health, optionally checks the Economist tool, inserts a synthetic ElevenLabs post-call transcript into D1, reads it back through the admin API, and can start a real Twilio test call when Twilio credentials, `TEST_CALL_FROM_NUMBER`, and `BARTLEBY_TWILIO_PHONE_NUMBER` are configured.

## Setup Plan

1. Set `.env` from `.env.example` with ElevenLabs, Twilio, RSS, and auth values.
2. Store Worker secrets with `wrangler secret put`.
3. Run `npm run elevenlabs:configure`.
4. Configure the ElevenLabs post-call transcription webhook to:
   `https://bartleby.aifurman.workers.dev/elevenlabs/post-call`
   Use HMAC verification via `ELEVENLABS_WEBHOOK_SECRET`, or use `ELEVENLABS_POST_CALL_TOKEN` with a `?token=...` URL for a simpler token-protected setup.
5. Set `ELEVENLABS_POST_CALL_WEBHOOK_ID` before running `npm run elevenlabs:configure` so the agent is attached to that post-call webhook.
6. Run `TWILIO_PURCHASE_CONFIRM=true npm run twilio:provision`.
7. Run `npm run smoke:test`.
8. Run a live conversation smoke test:
   - "What is new in The World in Brief?"
   - "What are the latest U.S. stories?"
   - "Find recent Business pieces about AI."
   - "Find recent Finance and Economics pieces about markets."
   - "Tell me more about the second article."
   - "Search the web for background on that topic."

## Public Repository Rules

This public repo should contain implementation code, docs, and sanitized examples only. It should not contain:

- private Economist RSS feed URLs
- copied article archives
- full-text article dumps
- Twilio account identifiers or auth tokens
- ElevenLabs API keys
- caller allow-list phone numbers
- local deployment files with secrets

The bot should summarize and discuss articles for the authorized caller. It should not republish full articles or expose subscriber feed data publicly.

## Initial Scope

The initial implementation includes:

- Cloudflare Worker webhook service
- Cloudflare D1 schema and deployed D1 database
- Economist RSS parser with category preservation
- Economist sections/recent/search/article tools
- narrow web-search fallback
- Twilio inbound-call route
- ElevenLabs post-call transcript logging
- admin transcript-read endpoints
- ElevenLabs tool configuration script
- Twilio number provisioning script
- smoke test script
- RSS parser tests
