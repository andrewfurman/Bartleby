const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const apiKey = process.env.ELEVENLABS_API_KEY;
const publicBaseUrl = stripTrailingSlash(process.env.BARTLEBY_PUBLIC_BASE_URL || "");
const toolToken = process.env.BARTLEBY_TOOL_TOKEN;
const telephonyFormat = process.env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || "ulaw_8000";
const agentName = process.env.ELEVENLABS_AGENT_NAME || "Bartleby Economist Bot";
const postCallWebhookId = process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID || "";

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
  first_message:
    conversationConfig.agent?.first_message ||
    "Hello, this is Bartleby. What would you like to discuss from The Economist?",
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
        full_article_available: booleanProperty("Whether full article text appears available from the RSS entry."),
        full_text: stringProperty("Article text or excerpt from RSS."),
        entry: objectProperty("Economist RSS entry.", articleProperty()),
      },
    }),
    webhookTool({
      name: "web_search",
      description:
        "Narrow outside-web fallback. Use only when Andrew explicitly asks for information outside The Economist, newer developments beyond an article, or when Economist tools return no relevant material.",
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
    section: stringProperty("Optional Economist section/category such as The World in Brief, The U.S. in Brief, Leaders, Business and Finance, Culture, or Obituary."),
    limit: integerProperty("Maximum entries to return. Use 5 by default for spoken answers."),
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
    full_text_available: booleanProperty("Whether full article text appears available."),
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
- Use economist_recent for latest stories and section browsing.
- Use economist_search for keyword, topic, person, company, country, and date questions.
- Use economist_article before giving detail on a specific article.
- Treat RSS category tags as Economist sections.
- Mention article title and section when grounding an answer.
- Say clearly when the RSS feed only provides an excerpt.

Outside web search policy:
- web_search is a narrow fallback, not the default.
- Use web_search only when Andrew explicitly asks for outside-Economist information, newer developments beyond an Economist article, background not explained by the article, or when Economist tools return no relevant material.
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
