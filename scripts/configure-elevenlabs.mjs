const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const apiKey = process.env.ELEVENLABS_API_KEY;
const publicBaseUrl = stripTrailingSlash(process.env.BARTLEBY_PUBLIC_BASE_URL || "");
const toolToken = process.env.BARTLEBY_TOOL_TOKEN;
const telephonyFormat = process.env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || "ulaw_8000";
const voiceId = process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9";
const agentName = process.env.ELEVENLABS_AGENT_NAME || "Bartleby Economist Bot";
const postCallWebhookId = process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID || "";
const firstMessage =
  process.env.ELEVENLABS_FIRST_MESSAGE ||
  "Hello, this is Bartleby. I have The Economist's latest feed loaded. What would you like to discuss?";

if (!apiKey) fail("Missing ELEVENLABS_API_KEY.");
if (!publicBaseUrl) fail("Missing BARTLEBY_PUBLIC_BASE_URL.");
if (!toolToken) fail("Missing BARTLEBY_TOOL_TOKEN.");

let agentId = process.env.ELEVENLABS_AGENT_ID || "";
if (!agentId) {
  const created = await requestJson(`${apiBase}/v1/convai/agents/create`, {
    method: "POST",
    body: JSON.stringify({
      name: agentName,
      conversation_config: {},
      tags: ["bartleby", "economist", "phone"],
    }),
  });
  agentId = created.agent_id;
}

const tools = [];
for (const config of toolConfigs()) {
  tools.push(await upsertTool(config));
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const conversationConfig = structuredClone(agent.conversation_config || {});
const currentPromptConfig = { ...(conversationConfig.agent?.prompt || {}) };
delete currentPromptConfig.tools;
const currentToolIds = currentPromptConfig.tool_ids || [];
const nextToolIds = unique([...currentToolIds, ...tools.map((tool) => tool.id)]);
const platformSettings = configuredPlatformSettings(agent.platform_settings, postCallWebhookId);

conversationConfig.agent = {
  ...(conversationConfig.agent || {}),
  first_message: firstMessage,
  prompt: {
    ...currentPromptConfig,
    prompt: bartlebyPrompt(),
    tool_ids: nextToolIds,
  },
};
conversationConfig.asr = {
  ...(conversationConfig.asr || {}),
  user_input_audio_format: telephonyFormat,
};
conversationConfig.tts = {
  ...(conversationConfig.tts || {}),
  voice_id: voiceId,
  agent_output_audio_format: telephonyFormat,
};

const updated = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`, {
  method: "PATCH",
  body: JSON.stringify({
    name: agentName,
    conversation_config: conversationConfig,
    ...(platformSettings ? { platform_settings: platformSettings } : {}),
    version_description: "Configure Bartleby Economist RSS tools",
  }),
});

console.log(
  JSON.stringify(
    {
      ok: true,
      agent_id: updated.agent_id || agentId,
      voice_id: voiceId,
      tool_ids: tools.map((tool) => ({
        id: tool.id,
        name: tool.tool_config?.name,
      })),
      next_steps: [
        "Set ELEVENLABS_AGENT_ID as a Worker secret or env var.",
        "Create an ElevenLabs post-call transcription webhook pointing at /elevenlabs/post-call.",
        "Set ELEVENLABS_POST_CALL_WEBHOOK_ID before configuring if the agent should be attached automatically.",
        "Set ELEVENLABS_WEBHOOK_SECRET for HMAC verification, or use ELEVENLABS_POST_CALL_TOKEN with a token URL.",
      ],
    },
    null,
    2
  )
);

async function upsertTool(toolConfig) {
  const existing = await findToolByName(toolConfig.name);
  if (existing) {
    return requestJson(`${apiBase}/v1/convai/tools/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ tool_config: toolConfig }),
    });
  }

  return requestJson(`${apiBase}/v1/convai/tools`, {
    method: "POST",
    body: JSON.stringify({ tool_config: toolConfig }),
  });
}

async function findToolByName(name) {
  const url = new URL(`${apiBase}/v1/convai/tools`);
  url.searchParams.set("search", name);
  url.searchParams.set("page_size", "100");
  url.searchParams.append("types", "webhook");
  const body = await requestJson(url.toString());
  return (body.tools || []).find((tool) => tool.tool_config?.name === name) || null;
}

function toolConfigs() {
  return [
    webhookTool({
      name: "economist_sections",
      description: "List sections found in The Economist RSS feed from RSS category tags.",
      url: `${publicBaseUrl}/tools/economist/sections`,
      required: [],
      responseTimeoutSecs: 30,
      requestProperties: {
        refresh: booleanProperty("Whether to force-refresh the Economist RSS feed cache."),
      },
      responseDescription: "Economist RSS section list.",
      responseProperties: {
        ok: booleanProperty("Whether the request succeeded."),
        status: stringProperty("Status code."),
        answer_text: stringProperty("Compact spoken summary."),
        sections: arrayProperty("Sections found in the feed.", {
          section: stringProperty("Section name from the RSS category tag."),
          count: integerProperty("Number of recent entries in this section."),
        }),
      },
    }),
    webhookTool({
      name: "economist_recent",
      description:
        "Return recent Economist RSS articles. Use this first for latest-news questions and section browsing.",
      url: `${publicBaseUrl}/tools/economist/recent`,
      required: [],
      responseTimeoutSecs: 30,
      requestProperties: articleListRequestProperties(),
      responseDescription: "Recent Economist RSS articles.",
      responseProperties: articleListResponseProperties(),
    }),
    webhookTool({
      name: "economist_search",
      description:
        "Search recent Economist RSS articles by keyword, section/category, and optional date range. Use this before web_search for Economist-grounded questions.",
      url: `${publicBaseUrl}/tools/economist/search`,
      required: [],
      responseTimeoutSecs: 30,
      requestProperties: {
        ...articleListRequestProperties(),
        query: stringProperty("Keyword or phrase to search for in Economist RSS entries."),
      },
      responseDescription: "Economist RSS search results.",
      responseProperties: articleListResponseProperties(),
    }),
    webhookTool({
      name: "economist_article",
      description:
        "Retrieve the longest available RSS text for a specific Economist article by entry id or URL.",
      url: `${publicBaseUrl}/tools/economist/article`,
      required: [],
      responseTimeoutSecs: 30,
      requestProperties: {
        entry_id: stringProperty("Entry id returned by economist_recent or economist_search."),
        article_url: stringProperty("Article URL returned by economist_recent or economist_search."),
        max_text_chars: integerProperty("Maximum text characters to return. Use 12000 by default for phone answers."),
        refresh: booleanProperty("Whether to force-refresh the Economist RSS feed cache."),
      },
      responseDescription: "Economist article text from RSS.",
      responseProperties: {
        ok: booleanProperty("Whether the request succeeded."),
        status: stringProperty("Status code."),
        answer_text: stringProperty("Compact spoken summary."),
        access_note: stringProperty("Note when the RSS feed only provides an excerpt."),
        full_article_available: booleanProperty("Whether full article text appears available."),
        content_source: stringProperty("Source for the returned text, such as article_txt, feed_content_encoded, feed_description_full_text, or feed_summary."),
        article_text_status: stringProperty("Status from the private /article.txt companion endpoint, when checked."),
        full_text_chars: integerProperty("Total available article text characters from the selected source."),
        returned_text_chars: integerProperty("Number of article text characters returned to the agent."),
        full_text_truncated: booleanProperty("Whether the returned full_text was truncated by max_text_chars."),
        full_text: stringProperty("Article text or excerpt from RSS."),
        entry: objectProperty("Economist RSS entry.", articleProperty()),
      },
    }),
    webhookTool({
      name: "web_search",
      description:
        "Narrow outside-web fallback. Must be called before answering whenever Andrew explicitly asks you to search the web, use outside web context, use the web_search tool, or find information outside The Economist.",
      url: `${publicBaseUrl}/tools/web-search`,
      required: ["query"],
      responseTimeoutSecs: 20,
      forcePreToolSpeech: true,
      toolCallSound: "typing",
      requestProperties: {
        query: stringProperty("Focused outside-web search query."),
        max_results: integerProperty("Maximum results to return. Use 3 by default."),
      },
      responseDescription: "Outside web search results.",
      responseProperties: {
        ok: booleanProperty("Whether the search succeeded."),
        status: stringProperty("Status code."),
        provider: stringProperty("Search provider."),
        query: stringProperty("Search query."),
        answer_text: stringProperty("Compact spoken summary."),
        results: arrayProperty("Search results.", {
          title: stringProperty("Result title."),
          url: stringProperty("Result URL."),
          snippet: stringProperty("Result snippet."),
          source: stringProperty("Source or provider."),
        }),
      },
    }),
  ];
}

function configuredPlatformSettings(currentSettings, webhookId) {
  if (!webhookId) return null;
  const platformSettings = structuredClone(currentSettings || {});
  platformSettings.workspace_overrides = {
    ...(platformSettings.workspace_overrides || {}),
    webhooks: {
      ...(platformSettings.workspace_overrides?.webhooks || {}),
      post_call_webhook_id: webhookId,
      events: ["transcript"],
      transcript_format: "json",
      send_audio: false,
    },
  };
  return platformSettings;
}

function articleListRequestProperties() {
  return {
    section: stringProperty("Optional single Economist section/category. Examples: United States, The US in Brief, Culture, Business, Finance and Economics, Leaders, Britain, Europe, The World in Brief."),
    category: stringProperty("Alias for section. Use this when the caller says category instead of section."),
    categories: stringArrayProperty("Optional Economist sections/categories to match any. Examples: Business, Finance and Economics."),
    limit: integerProperty("Maximum entries to return. Use 200 for broad scans and 5 for short spoken lists."),
    start_date: stringProperty("Optional start date."),
    end_date: stringProperty("Optional end date."),
    refresh: booleanProperty("Whether to force-refresh the Economist RSS feed cache."),
  };
}

function articleListResponseProperties() {
  return {
    ok: booleanProperty("Whether the request succeeded."),
    status: stringProperty("Status code."),
    answer_text: stringProperty("Compact spoken summary."),
    query: stringProperty("Search query when applicable."),
    section: stringProperty("Section filter when applicable."),
    categories: stringArrayProperty("Resolved Economist section/category filters."),
    returned_count: integerProperty("Number of entries returned."),
    items: arrayProperty("Economist RSS entries.", articleProperty()),
  };
}

function articleProperty() {
  return {
    id: stringProperty("Stable RSS entry id."),
    title: stringProperty("Article title."),
    url: stringProperty("Article URL."),
    author: stringProperty("Author when available."),
    published_at: stringProperty("Publication timestamp."),
    section: stringProperty("Primary Economist section/category."),
    categories: stringArrayProperty("All RSS category tags."),
    content_source: stringProperty("RSS source for the entry text, such as feed_content_encoded or feed_summary."),
    full_text_available: booleanProperty("Whether full article text appears available."),
    reading_time: integerProperty("Estimated reading time in minutes."),
    excerpt: stringProperty("Short excerpt from the RSS entry."),
  };
}

function webhookTool({
  name,
  description,
  url,
  required,
  requestProperties,
  responseDescription,
  responseProperties,
  responseTimeoutSecs = 15,
  forcePreToolSpeech = false,
  toolCallSound = null,
}) {
  return {
    type: "webhook",
    name,
    description,
    response_timeout_secs: responseTimeoutSecs,
    disable_interruptions: false,
    force_pre_tool_speech: forcePreToolSpeech,
    pre_tool_speech: "auto",
    assignments: [],
    tool_call_sound: toolCallSound,
    tool_call_sound_behavior: "auto",
    tool_error_handling_mode: "auto",
    dynamic_variables: { dynamic_variable_placeholders: {} },
    execution_mode: "immediate",
    api_schema: {
      request_headers: { Authorization: `Bearer ${toolToken}` },
      url,
      method: "POST",
      path_params_schema: {},
      query_params_schema: null,
      request_body_schema: {
        type: "object",
        required,
        description: "",
        properties: requestProperties,
      },
      response_body_schema: {
        type: "object",
        required: [],
        description: responseDescription,
        properties: responseProperties,
      },
      content_type: "application/json",
      auth_resolved_params: [],
      auth_connection: null,
    },
  };
}

function stringProperty(description) {
  return {
    type: "string",
    description,
    enum: null,
    nullable: false,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
  };
}

function integerProperty(description) {
  return {
    type: "integer",
    description,
    enum: null,
    nullable: false,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
  };
}

function booleanProperty(description) {
  return {
    type: "boolean",
    description,
    enum: null,
    nullable: false,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
  };
}

function stringArrayProperty(description) {
  return {
    type: "array",
    description,
    items: stringProperty("Array item."),
    dynamic_variable: "",
    constant_value: null,
    is_omitted: false,
  };
}

function arrayProperty(description, properties) {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      required: [],
      description: "Array item.",
      properties,
    },
    dynamic_variable: "",
    constant_value: null,
    is_omitted: false,
  };
}

function objectProperty(description, properties) {
  return {
    type: "object",
    required: [],
    description,
    properties,
  };
}

function bartlebyPrompt() {
  return `You are Bartleby, Andrew's phone-call companion for reading and discussing The Economist.

Primary source policy:
- Default to The Economist RSS tools for article lists, article search, and article discussion.
- Use the startup context first for latest stories and section browsing.
- Use economist_recent for follow-up latest-story and section browsing. For broad scans, request limit 200, not 5.
- For section browsing, pass a section/category filter such as United States, The US in Brief, Culture, Business, Finance and Economics, Leaders, Britain, Europe, or The World in Brief.
- Keep The US in Brief separate from the United States section. Use section "The US in Brief" for the daily brief and section "United States" for the standard U.S. section.
- Keep Business separate from Finance and Economics. Use section "Business" for the Business section and section "Finance and Economics" for the Finance and Economics section.
- Use economist_search for keyword, topic, person, company, country, and date questions, including within a section/category.
- Use economist_article before giving detail on a specific article or answering whether full article text is available.
- If Andrew asks for more detail, more information, a deeper explanation, or "tell me more" about a specific article or listed item, call economist_article immediately for that article. Do not ask whether he wants the full text first.
- If Andrew asks you to use, test, check, or verify tools, make the requested Economist tool calls even when startup context already has enough information.
- Treat RSS category tags as Economist sections.
- Mention article title and section when grounding an answer.
- Say clearly when the RSS feed only provides an excerpt.

Startup context:
- At the start of every phone call, the webhook injects a startup context before Andrew speaks.
- This context contains the latest U.S. in Brief entry when present, the latest World in Brief entry when present, and an index of up to 200 recent Economist RSS articles.
- Use this context before making a tool call or saying that a section/article is missing.
- The current private RSS feed is an index plus previews for most articles; economist_article can retrieve cached full text through the private article text endpoint.
- Startup context excerpts are short previews. If Andrew asks for more, use economist_article before saying full text is unavailable.
- If Andrew asks for World in Brief and the startup context says it was not found, say that the configured RSS feed did not include a World in Brief entry in the preloaded recent article index. Do not imply you checked only five articles.

Injected startup context:
{{bartleby_bootstrap_context}}

Outside web search policy:
- web_search is a narrow fallback, not the default.
- Use web_search only when Andrew explicitly asks for outside-Economist information, newer developments beyond an Economist article, background not explained by the article, or when Economist tools return no relevant material.
- Treat phrases like "search the web", "web search", "outside web context", "outside The Economist", "use web_search", and "use the web search tool" as explicit external-search requests.
- If Andrew explicitly asks for an external-search request, call web_search before answering. Do not answer these requests from memory alone, and do not name an outside source or source title until web_search has returned results.
- When using web_search, say the added context comes from outside The Economist.

Voice style:
- Be concise and conversational.
- Start with the answer, then offer to go deeper.
- Do not read long lists unless Andrew asks.
- If a tool result includes answer_text, use it as the compact spoken starting point.`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${text.slice(0, 1000)}`);
  }
  return body;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
