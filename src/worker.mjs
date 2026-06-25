import {
  economistArticle,
  economistBootstrap,
  economistRecent,
  economistSearch,
  economistSections,
} from "./rss.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const XML_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": "no-store",
};

const OUTSIDE_COVERAGE_MESSAGE =
  "This number is for Andrew's Bartleby bot and is not available from this caller.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        name: "Bartleby",
        endpoints: {
          health: "GET /health",
          twilio_inbound: "POST /twilio/inbound",
          twilio_status: "POST /twilio/status",
          elevenlabs_post_call: "POST /elevenlabs/post-call",
          economist_sections: "POST /tools/economist/sections",
          economist_recent: "POST /tools/economist/recent",
          economist_search: "POST /tools/economist/search",
          economist_article: "POST /tools/economist/article",
          economist_bootstrap: "POST /tools/economist/bootstrap",
          web_search: "POST /tools/web-search",
          admin_conversations: "GET /admin/conversations",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        d1_configured: Boolean(env.DB),
        elevenlabs_agent_configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
        economist_rss_configured: Boolean(env.ECONOMIST_RSS_URL || env.ECONOMIST_RSS_CONFIG_JSON),
        economist_rss_auth_configured: Boolean(env.ECONOMIST_RSS_BEARER_TOKEN || env.ECONOMIST_RSS_AUTH_TOKEN),
        tool_auth_configured: Boolean(env.BARTLEBY_TOOL_TOKEN),
        twilio_webhook_token_configured: Boolean(env.TWILIO_WEBHOOK_TOKEN),
        allowed_callers_configured: parseAllowedCallerNumbers(env.ALLOWED_CALLER_NUMBERS).length > 0,
        post_call_auth_configured: Boolean(
          env.ELEVENLABS_POST_CALL_TOKEN || env.ELEVENLABS_WEBHOOK_SECRET
        ),
      });
    }

    if (request.method === "POST" && url.pathname === "/twilio/inbound") {
      return handleTwilioInbound(request, env);
    }

    if (request.method === "POST" && url.pathname === "/twilio/status") {
      return handleTwilioStatus(request, env, ctx, "twilio_status");
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === "/twilio/test-caller-script"
    ) {
      if (!isValidTwilioRequest(request, env)) {
        return xml(sayTwiml("Unauthorized."), 403);
      }
      return xml(testCallerTwiml(env));
    }

    if (request.method === "POST" && url.pathname === "/twilio/stream-status") {
      return handleTwilioStatus(request, env, ctx, "twilio_stream_status");
    }

    if (request.method === "POST" && url.pathname === "/elevenlabs/post-call") {
      return handleElevenLabsPostCall(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/tools/economist/sections") {
      return withToolAuth(request, env, async () => json(await economistSections(env, await requestJson(request))));
    }

    if (request.method === "POST" && url.pathname === "/tools/economist/recent") {
      return withToolAuth(request, env, async () => json(await economistRecent(env, await requestJson(request))));
    }

    if (request.method === "POST" && url.pathname === "/tools/economist/search") {
      return withToolAuth(request, env, async () => json(await economistSearch(env, await requestJson(request))));
    }

    if (request.method === "POST" && url.pathname === "/tools/economist/article") {
      return withToolAuth(request, env, async () => json(await economistArticle(env, await requestJson(request))));
    }

    if (request.method === "POST" && url.pathname === "/tools/economist/bootstrap") {
      return withToolAuth(request, env, async () => json(await economistBootstrap(env, await requestJson(request))));
    }

    if (request.method === "POST" && url.pathname === "/tools/web-search") {
      return withToolAuth(request, env, async () => json(await webSearch(env, await requestJson(request))));
    }

    if (request.method === "GET" && url.pathname === "/admin/conversations") {
      return withAdminAuth(request, env, () => listConversations(request, env));
    }

    if (request.method === "GET" && url.pathname.startsWith("/admin/conversations/")) {
      const conversationId = decodeURIComponent(url.pathname.replace("/admin/conversations/", ""));
      return withAdminAuth(request, env, () => getConversation(env, conversationId));
    }

    if (request.method === "GET" && url.pathname.startsWith("/admin/calls/")) {
      const callSid = decodeURIComponent(url.pathname.replace("/admin/calls/", ""));
      return withAdminAuth(request, env, () => getCall(env, callSid));
    }

    return json({ ok: false, status: "not_found" }, 404);
  },
};

async function handleTwilioInbound(request, env) {
  if (!isValidTwilioRequest(request, env)) {
    return xml(sayTwiml("Unauthorized."), 403);
  }

  const body = await requestBody(request);
  const fromNumber = body.From || body.Caller || body.from_number || body.fromNumber || "";
  const toNumber = body.To || body.Called || body.to_number || body.toNumber || env.TWILIO_PHONE_NUMBER || "";
  const callSid = body.CallSid || body.call_sid || body.callSid || "";

  await storeTwilioEvent(env, {
    source: "twilio_inbound",
    payload: body,
    twilio_call_sid: callSid,
    event_type: "inbound",
    call_status: body.CallStatus || "ringing",
    caller_number: fromNumber,
    called_number: toNumber,
    occurred_at: nowIso(),
  });

  const allowed = isAllowedCaller(fromNumber, env.ALLOWED_CALLER_NUMBERS);
  await upsertCallFromTwilio(env, {
    twilio_call_sid: callSid,
    caller_number: fromNumber,
    called_number: toNumber,
    direction: "inbound",
    status: body.CallStatus || "ringing",
    allowlist_result: allowed ? "allowed" : "rejected",
  });

  if (!allowed) {
    return xml(sayTwiml(env.OUTSIDE_COVERAGE_MESSAGE || OUTSIDE_COVERAGE_MESSAGE));
  }

  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) {
    return xml(sayTwiml("Bartleby is not connected to ElevenLabs yet."));
  }

  try {
    const twiml = await registerElevenLabsCall(env, request, {
      fromNumber,
      toNumber,
      callSid,
      direction: "inbound",
    });
    return xml(twiml);
  } catch (error) {
    await storeTwilioEvent(env, {
      source: "twilio_inbound",
      payload: { error: error?.message || String(error), callSid },
      twilio_call_sid: callSid,
      event_type: "elevenlabs_register_failed",
      call_status: "failed",
      caller_number: fromNumber,
      called_number: toNumber,
      occurred_at: nowIso(),
    });
    return xml(sayTwiml("Bartleby could not connect the voice agent. Please try again later."));
  }
}

async function registerElevenLabsCall(env, request, { fromNumber, toNumber, callSid, direction }) {
  const apiBase = env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
  const bootstrap = await economistBootstrap(env, {});
  const response = await fetch(`${apiBase}/v1/convai/twilio/register-call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      from_number: fromNumber,
      to_number: toNumber,
      direction,
      conversation_initiation_client_data: {
        dynamic_variables: {
          caller_number: fromNumber,
          twilio_number: toNumber,
          twilio_call_sid: callSid || "",
          telephony_audio_format: env.ELEVENLABS_TELEPHONY_AUDIO_FORMAT || "ulaw_8000",
          bartleby_bootstrap_status: bootstrap.ok ? "ok" : bootstrap.status || "error",
          bartleby_bootstrap_context: bootstrap.ok ? bootstrap.context_text : bootstrap.answer_text || "",
          bartleby_recent_article_count: bootstrap.ok ? String(bootstrap.recent_article_count) : "0",
          bartleby_us_in_brief_title: bootstrap.ok && bootstrap.us_in_brief ? bootstrap.us_in_brief.title : "",
          bartleby_world_in_brief_title: bootstrap.ok && bootstrap.world_in_brief ? bootstrap.world_in_brief.title : "",
        },
      },
    }),
  });

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs register-call failed (${response.status}): ${text.slice(0, 800)}`);
  }

  return attachStreamStatusCallback(extractTwiml(text, contentType), callbackUrl(request, env, "/twilio/stream-status"));
}

async function handleTwilioStatus(request, env, ctx, source) {
  if (!isValidTwilioRequest(request, env)) {
    return json({ ok: false, status: "unauthorized" }, 403);
  }

  const body = await requestBody(request);
  const event = {
    source,
    payload: body,
    twilio_call_sid: body.CallSid || body.call_sid || body.callSid || "",
    event_type: body.StreamEvent || body.CallStatus || body.CallbackSource || source,
    call_status: body.CallStatus || body.StreamEvent || "",
    caller_number: body.From || body.Caller || "",
    called_number: body.To || body.Called || "",
    occurred_at: normalizeDate(body.Timestamp) || nowIso(),
  };

  const tasks = [
    storeTwilioEvent(env, event),
    upsertCallFromTwilio(env, {
      twilio_call_sid: event.twilio_call_sid,
      caller_number: event.caller_number,
      called_number: event.called_number,
      status: event.call_status,
      ended_at: isTerminalCallStatus(event.call_status) ? event.occurred_at : "",
      duration_secs: toInteger(body.CallDuration || body.Duration, null),
    }),
  ];

  if (ctx?.waitUntil) ctx.waitUntil(Promise.allSettled(tasks));
  else await Promise.allSettled(tasks);

  return json({ ok: true });
}

async function handleElevenLabsPostCall(request, env, ctx) {
  const rawBody = await request.text();
  const auth = await validateElevenLabsWebhook(request, env, rawBody);
  if (!auth.ok) return json(auth, auth.statusCode || 401);

  const event = parseMaybeJson(rawBody);
  if (!event || typeof event !== "object") {
    return json({ ok: false, status: "invalid_json" }, 400);
  }

  const task = storeElevenLabsEvent(env, event);
  if (ctx?.waitUntil) {
    ctx.waitUntil(task);
    return json({ ok: true, status: "accepted" });
  }

  await task;
  return json({ ok: true, status: "stored" });
}

async function storeElevenLabsEvent(env, event) {
  ensureD1(env);

  if (event.type === "call_initiation_failure") {
    const data = event.data || {};
    const metadata = data.metadata || {};
    const body = metadata.body || {};
    const callSid = body.CallSid || body.call_sid || "";
    if (callSid) {
      await upsertCallFromTwilio(env, {
        twilio_call_sid: callSid,
        elevenlabs_conversation_id: data.conversation_id || "",
        agent_id: data.agent_id || "",
        status: data.failure_reason || "call_initiation_failure",
        metadata_json: JSON.stringify(metadata),
      });
    }
    return;
  }

  if (event.type !== "post_call_transcription") return;

  const data = event.data || {};
  const conversationId = data.conversation_id || "";
  if (!conversationId) throw new Error("post_call_transcription missing conversation_id");

  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  const dynamicVariables = data.conversation_initiation_client_data?.dynamic_variables || {};
  const metadata = data.metadata || {};
  const analysis = data.analysis || {};
  const callSid =
    dynamicVariables.twilio_call_sid ||
    metadata.twilio_call_sid ||
    metadata.call_sid ||
    metadata.phone_call?.call_sid ||
    "";
  const startTime = unixToIso(metadata.start_time_unix_secs || event.event_timestamp);
  const duration = toInteger(metadata.call_duration_secs, null);
  const endedAt = startTime && duration !== null ? new Date(new Date(startTime).getTime() + duration * 1000).toISOString() : "";
  const transcriptText = transcript
    .map((turn) => `${turn.role || "unknown"}: ${normalize(turn.message)}`)
    .filter((line) => line.trim() !== "unknown:")
    .join("\n");
  const summary = analysis.transcript_summary || analysis.summary || "";

  const callStatement = callSid
    ? env.DB.prepare(
        `INSERT INTO calls (
          twilio_call_sid, elevenlabs_conversation_id, agent_id, agent_name, caller_number,
          called_number, direction, status, started_at, ended_at, duration_secs, summary,
          transcript_text, metadata_json, analysis_json, initiation_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(twilio_call_sid) DO UPDATE SET
          elevenlabs_conversation_id = excluded.elevenlabs_conversation_id,
          agent_id = excluded.agent_id,
          agent_name = excluded.agent_name,
          caller_number = COALESCE(NULLIF(excluded.caller_number, ''), calls.caller_number),
          called_number = COALESCE(NULLIF(excluded.called_number, ''), calls.called_number),
          direction = COALESCE(NULLIF(excluded.direction, ''), calls.direction),
          status = excluded.status,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          duration_secs = excluded.duration_secs,
          summary = excluded.summary,
          transcript_text = excluded.transcript_text,
          metadata_json = excluded.metadata_json,
          analysis_json = excluded.analysis_json,
          initiation_json = excluded.initiation_json,
          updated_at = excluded.updated_at`
      ).bind(
        callSid,
        conversationId,
        data.agent_id || "",
        data.agent_name || "",
        dynamicVariables.caller_number || "",
        dynamicVariables.twilio_number || "",
        "inbound",
        data.status || "done",
        startTime,
        endedAt,
        duration,
        summary,
        transcriptText,
        JSON.stringify(metadata),
        JSON.stringify(analysis),
        JSON.stringify(data.conversation_initiation_client_data || {}),
        nowIso()
      )
    : env.DB.prepare(
        `INSERT INTO calls (
          elevenlabs_conversation_id, agent_id, agent_name, status, started_at, ended_at,
          duration_secs, summary, transcript_text, metadata_json, analysis_json, initiation_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(elevenlabs_conversation_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          agent_name = excluded.agent_name,
          status = excluded.status,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          duration_secs = excluded.duration_secs,
          summary = excluded.summary,
          transcript_text = excluded.transcript_text,
          metadata_json = excluded.metadata_json,
          analysis_json = excluded.analysis_json,
          initiation_json = excluded.initiation_json,
          updated_at = excluded.updated_at`
      ).bind(
        conversationId,
        data.agent_id || "",
        data.agent_name || "",
        data.status || "done",
        startTime,
        endedAt,
        duration,
        summary,
        transcriptText,
        JSON.stringify(metadata),
        JSON.stringify(analysis),
        JSON.stringify(data.conversation_initiation_client_data || {}),
        nowIso()
      );

  const statements = [
    callStatement,
    env.DB.prepare("DELETE FROM transcript_turns WHERE elevenlabs_conversation_id = ?").bind(conversationId),
    env.DB.prepare("DELETE FROM tool_events WHERE elevenlabs_conversation_id = ?").bind(conversationId),
  ];

  transcript.forEach((turn, index) => {
    const toolCalls = sanitizeForStorage(Array.isArray(turn.tool_calls) ? turn.tool_calls : []);
    const toolResults = sanitizeForStorage(Array.isArray(turn.tool_results) ? turn.tool_results : []);
    statements.push(
      env.DB.prepare(
        `INSERT INTO transcript_turns (
          elevenlabs_conversation_id, turn_index, role, message, time_in_call_secs,
          tool_calls_json, tool_results_json, metrics_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        conversationId,
        index,
        turn.role || "",
        turn.message || "",
        numericOrNull(turn.time_in_call_secs),
        JSON.stringify(toolCalls),
        JSON.stringify(toolResults),
        JSON.stringify(turn.conversation_turn_metrics || {})
      )
    );

    for (const toolCall of toolCalls) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO tool_events (elevenlabs_conversation_id, turn_index, event_type, tool_name, payload_json) VALUES (?, ?, ?, ?, ?)"
        ).bind(conversationId, index, "call", toolName(toolCall), JSON.stringify(toolCall))
      );
    }
    for (const toolResult of toolResults) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO tool_events (elevenlabs_conversation_id, turn_index, event_type, tool_name, payload_json) VALUES (?, ?, ?, ?, ?)"
        ).bind(conversationId, index, "result", toolName(toolResult), JSON.stringify(toolResult))
      );
    }
  });

  await env.DB.batch(statements);
}

async function upsertCallFromTwilio(env, data) {
  ensureD1(env);
  if (!data.twilio_call_sid) return;

  await env.DB.prepare(
    `INSERT INTO calls (
      twilio_call_sid, elevenlabs_conversation_id, agent_id, caller_number, called_number,
      direction, status, allowlist_result, ended_at, duration_secs, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(twilio_call_sid) DO UPDATE SET
      elevenlabs_conversation_id = COALESCE(NULLIF(excluded.elevenlabs_conversation_id, ''), calls.elevenlabs_conversation_id),
      agent_id = COALESCE(NULLIF(excluded.agent_id, ''), calls.agent_id),
      caller_number = COALESCE(NULLIF(excluded.caller_number, ''), calls.caller_number),
      called_number = COALESCE(NULLIF(excluded.called_number, ''), calls.called_number),
      direction = COALESCE(NULLIF(excluded.direction, ''), calls.direction),
      status = COALESCE(NULLIF(excluded.status, ''), calls.status),
      allowlist_result = COALESCE(NULLIF(excluded.allowlist_result, ''), calls.allowlist_result),
      ended_at = COALESCE(NULLIF(excluded.ended_at, ''), calls.ended_at),
      duration_secs = COALESCE(excluded.duration_secs, calls.duration_secs),
      metadata_json = COALESCE(NULLIF(excluded.metadata_json, '{}'), calls.metadata_json),
      updated_at = excluded.updated_at`
    )
    .bind(
      data.twilio_call_sid,
      nullableText(data.elevenlabs_conversation_id),
      data.agent_id || "",
      data.caller_number || "",
      data.called_number || "",
      data.direction || "",
      data.status || "",
      data.allowlist_result || "",
      data.ended_at || "",
      data.duration_secs ?? null,
      data.metadata_json || "{}",
      nowIso()
    )
    .run();
}

async function storeTwilioEvent(env, event) {
  ensureD1(env);
  const id = [
    event.source || "twilio",
    event.twilio_call_sid || "no-call-sid",
    event.event_type || "event",
    event.occurred_at || nowIso(),
    hash(JSON.stringify(event.payload || {})).toString(36),
  ].join(":");

  await env.DB.prepare(
    `INSERT OR REPLACE INTO twilio_events (
      id, twilio_call_sid, event_type, call_status, caller_number, called_number, occurred_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      event.twilio_call_sid || "",
      event.event_type || "",
      event.call_status || "",
      event.caller_number || "",
      event.called_number || "",
      event.occurred_at || nowIso(),
      JSON.stringify(event.payload || {})
    )
    .run();
}

async function listConversations(request, env) {
  ensureD1(env);
  const url = new URL(request.url);
  const limit = clampInteger(url.searchParams.get("limit"), 1, 100, 25);
  const rows = await env.DB.prepare(
    `SELECT id, twilio_call_sid, elevenlabs_conversation_id, caller_number, called_number,
      status, allowlist_result, started_at, ended_at, duration_secs, summary, updated_at
     FROM calls
     ORDER BY COALESCE(started_at, updated_at, created_at) DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return json({ ok: true, returned_count: rows.results?.length || 0, conversations: rows.results || [] });
}

async function getConversation(env, conversationId) {
  ensureD1(env);
  const call = await env.DB.prepare("SELECT * FROM calls WHERE elevenlabs_conversation_id = ?")
    .bind(conversationId)
    .first();
  if (!call) return json({ ok: false, status: "conversation_not_found" }, 404);

  const turns = await env.DB.prepare(
    "SELECT * FROM transcript_turns WHERE elevenlabs_conversation_id = ? ORDER BY turn_index ASC"
  )
    .bind(conversationId)
    .all();
  const tools = await env.DB.prepare(
    "SELECT * FROM tool_events WHERE elevenlabs_conversation_id = ? ORDER BY turn_index ASC, id ASC"
  )
    .bind(conversationId)
    .all();
  const events = call.twilio_call_sid
    ? await env.DB.prepare("SELECT * FROM twilio_events WHERE twilio_call_sid = ? ORDER BY occurred_at ASC")
        .bind(call.twilio_call_sid)
        .all()
    : { results: [] };

  return json({
    ok: true,
    conversation: parseCallRow(call),
    transcript_turns: (turns.results || []).map(parseTurnRow),
    tool_events: (tools.results || []).map(parseToolRow),
    twilio_events: (events.results || []).map(parseTwilioEventRow),
  });
}

async function getCall(env, callSid) {
  ensureD1(env);
  const call = await env.DB.prepare("SELECT * FROM calls WHERE twilio_call_sid = ?").bind(callSid).first();
  if (!call) return json({ ok: false, status: "call_not_found" }, 404);
  if (call.elevenlabs_conversation_id) return getConversation(env, call.elevenlabs_conversation_id);

  const events = await env.DB.prepare("SELECT * FROM twilio_events WHERE twilio_call_sid = ? ORDER BY occurred_at ASC")
    .bind(callSid)
    .all();
  return json({ ok: true, conversation: parseCallRow(call), transcript_turns: [], tool_events: [], twilio_events: (events.results || []).map(parseTwilioEventRow) });
}

async function webSearch(env, { query = "", max_results: maxResults = 3 } = {}) {
  const normalizedQuery = normalize(query);
  const boundedMaxResults = clampInteger(maxResults, 1, 8, 3);
  const providerErrors = [];
  if (!normalizedQuery) {
    return {
      ok: false,
      status: "missing_query",
      answer_text: "A web search query is required.",
      results: [],
    };
  }

  if (env.WEBSEARCH && typeof env.WEBSEARCH.search === "function") {
    try {
      const body = await cloudflareWebSearch(env.WEBSEARCH, normalizedQuery, boundedMaxResults);
      const results = normalizeSearchResults(body, "cloudflare_websearch").slice(0, boundedMaxResults);
      if (results.length) {
        return {
          ok: true,
          status: "ok",
          provider: "cloudflare_websearch",
          query: normalizedQuery,
          answer_text: `I found ${results.length} outside web result${results.length === 1 ? "" : "s"}.`,
          results,
        };
      }
      providerErrors.push("cloudflare_websearch returned no results");
    } catch (error) {
      providerErrors.push(`cloudflare_websearch failed: ${error?.message || String(error)}`);
    }
  }

  if (env.TAVILY_API_KEY) {
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: env.TAVILY_API_KEY,
          query: normalizedQuery,
          max_results: clampInteger(maxResults, 1, 8, 3),
          search_depth: env.TAVILY_SEARCH_DEPTH || "basic",
          include_answer: true,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        const results = normalizeSearchResults(body, "tavily").slice(0, boundedMaxResults);
        if (results.length) {
          return {
            ok: true,
            status: "ok",
            provider: "tavily",
            query: normalizedQuery,
            answer_text: body.answer || `I found ${results.length} outside web result${results.length === 1 ? "" : "s"}.`,
            results,
          };
        }
        providerErrors.push("tavily returned no results");
      } else {
        providerErrors.push(`tavily failed with HTTP ${response.status}`);
      }
    } catch (error) {
      providerErrors.push(`tavily failed: ${error?.message || String(error)}`);
    }
  }

  const instantResults = await duckDuckGoInstantSearch(normalizedQuery, boundedMaxResults).catch((error) => {
    providerErrors.push(`duckduckgo instant failed: ${error?.message || String(error)}`);
    return [];
  });
  if (instantResults.length) {
    return {
      ok: true,
      status: "ok",
      provider: "duckduckgo",
      query: normalizedQuery,
      answer_text: `I found ${instantResults.length} outside web result${instantResults.length === 1 ? "" : "s"}.`,
      results: instantResults,
    };
  }

  const htmlResults = await duckDuckGoHtmlSearch(normalizedQuery, boundedMaxResults).catch((error) => {
    providerErrors.push(`duckduckgo html failed: ${error?.message || String(error)}`);
    return [];
  });
  if (htmlResults.length) {
    return {
      ok: true,
      status: "ok",
      provider: "duckduckgo_html",
      query: normalizedQuery,
      answer_text: `I found ${htmlResults.length} outside web result${htmlResults.length === 1 ? "" : "s"}.`,
      results: htmlResults,
    };
  }

  const bingResults = await bingHtmlSearch(normalizedQuery, boundedMaxResults).catch((error) => {
    providerErrors.push(`bing html failed: ${error?.message || String(error)}`);
    return [];
  });
  if (bingResults.length) {
    return {
      ok: true,
      status: "ok",
      provider: "bing_html",
      query: normalizedQuery,
      answer_text: `I found ${bingResults.length} outside web result${bingResults.length === 1 ? "" : "s"}.`,
      results: bingResults,
    };
  }

  return {
    ok: false,
    status: "no_web_results",
    provider: "none",
    query: normalizedQuery,
    answer_text: "I could not find useful outside web results.",
    provider_errors: providerErrors.slice(0, 5),
    results: [],
  };
}

async function cloudflareWebSearch(binding, query, maxResults) {
  try {
    return await binding.search(query, { limit: maxResults });
  } catch (firstError) {
    try {
      return await binding.search({ query, limit: maxResults });
    } catch {
      throw firstError;
    }
  }
}

async function duckDuckGoInstantSearch(query, maxResults) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  const response = await fetch(url.toString(), {
    headers: { "user-agent": "bartleby-web-search/0.1" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json().catch(() => ({}));
  const related = flattenDuckDuckGoTopics(body.RelatedTopics || []);
  return [
    body.AbstractText
      ? {
          title: cleanSearchText(body.Heading || query),
          url: body.AbstractURL || "",
          snippet: cleanSearchText(body.AbstractText),
          source: body.AbstractSource || "duckduckgo",
        }
      : null,
    ...related,
  ]
    .filter((item) => item?.title || item?.snippet)
    .slice(0, maxResults);
}

async function duckDuckGoHtmlSearch(query, maxResults) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url.toString(), {
    headers: { "user-agent": "bartleby-web-search/0.1" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const linkMatches = [
    ...html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ];
  const snippets = [
    ...html.matchAll(/<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi),
  ].map((match) => cleanSearchText(match[1]));

  return linkMatches
    .map((match, index) => ({
      title: cleanSearchText(match[2]),
      url: duckDuckGoResultUrl(match[1]),
      snippet: snippets[index] || "",
      source: "duckduckgo_html",
    }))
    .filter((item) => item.title && item.url)
    .slice(0, maxResults);
}

async function bingHtmlSearch(query, maxResults) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetch(url.toString(), {
    headers: { "user-agent": "Mozilla/5.0 bartleby-web-search/0.1" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const blocks = [...html.matchAll(/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][\s\S]*?<\/li>/gi)].map(
    (match) => match[0]
  );

  return blocks
    .map((block) => {
      const link = block.match(/<h2[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      return {
        title: cleanSearchText(link?.[2] || ""),
        url: bingResultUrl(link?.[1] || ""),
        snippet: cleanSearchText(snippet?.[1] || ""),
        source: "bing_html",
      };
    })
    .filter((item) => item.title && item.url)
    .slice(0, maxResults);
}

function normalizeSearchResults(body, source) {
  const rawItems = body?.items || body?.results || body?.webPages?.value || [];
  return rawItems
    .map((item) => ({
      title: cleanSearchText(item.title || item.name || item.heading || ""),
      url: item.url || item.link || item.href || "",
      snippet: cleanSearchText(item.snippet || item.content || item.description || item.text || ""),
      source,
    }))
    .filter((item) => item.title || item.snippet);
}

function flattenDuckDuckGoTopics(topics) {
  const results = [];
  for (const topic of topics) {
    if (Array.isArray(topic.Topics)) {
      results.push(...flattenDuckDuckGoTopics(topic.Topics));
    } else if (topic.Text || topic.FirstURL) {
      results.push({
        title: cleanSearchText(topic.Text?.split(" - ")[0] || topic.FirstURL || ""),
        url: topic.FirstURL || "",
        snippet: cleanSearchText(topic.Text || ""),
        source: "duckduckgo",
      });
    }
  }
  return results;
}

function duckDuckGoResultUrl(value) {
  const text = decodeHtmlEntities(String(value || ""));
  try {
    const absolute = text.startsWith("//") ? `https:${text}` : text;
    const url = new URL(absolute);
    return url.searchParams.get("uddg") || absolute;
  } catch {
    return text;
  }
}

function bingResultUrl(value) {
  const text = decodeHtmlEntities(String(value || ""));
  try {
    const url = new URL(text);
    const encoded = url.searchParams.get("u");
    if (encoded?.startsWith("a1")) {
      return base64UrlDecode(encoded.slice(2));
    }
    return text;
  } catch {
    return text;
  }
}

function base64UrlDecode(value) {
  const base64 = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function cleanSearchText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function parseCallRow(row) {
  return {
    ...row,
    metadata: parseMaybeJson(row.metadata_json) || {},
    analysis: parseMaybeJson(row.analysis_json) || {},
    initiation: parseMaybeJson(row.initiation_json) || {},
  };
}

function parseTurnRow(row) {
  return {
    ...row,
    tool_calls: parseMaybeJson(row.tool_calls_json) || [],
    tool_results: parseMaybeJson(row.tool_results_json) || [],
    metrics: parseMaybeJson(row.metrics_json) || {},
  };
}

function parseToolRow(row) {
  return {
    ...row,
    payload: parseMaybeJson(row.payload_json) || {},
  };
}

function parseTwilioEventRow(row) {
  return {
    ...row,
    payload: parseMaybeJson(row.payload_json) || {},
  };
}

function sanitizeForStorage(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeForStorage(item));
  if (!value || typeof value !== "object") return redactSecretText(value);

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? "[redacted]" : sanitizeForStorage(child);
  }
  return output;
}

function isSecretKey(key) {
  return /authorization|api[-_]?key|secret|token|password/i.test(String(key || ""));
}

function redactSecretText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&]token=)[^&\s"'<]+/gi, "$1redacted");
}

async function validateElevenLabsWebhook(request, env, rawBody) {
  const token = env.ELEVENLABS_POST_CALL_TOKEN || "";
  if (token) {
    const url = new URL(request.url);
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (url.searchParams.get("token") === token || bearer === token) return { ok: true };
  }

  const secret = env.ELEVENLABS_WEBHOOK_SECRET || "";
  if (secret) {
    const header = request.headers.get("elevenlabs-signature") || request.headers.get("ElevenLabs-Signature") || "";
    if (header && (await verifyWebhookSignature(header, rawBody, secret))) return { ok: true };
  }

  if (!token && !secret) {
    return {
      ok: false,
      status: "post_call_auth_not_configured",
      statusCode: 503,
      message: "Set ELEVENLABS_POST_CALL_TOKEN or ELEVENLABS_WEBHOOK_SECRET.",
    };
  }

  return { ok: false, status: "unauthorized", statusCode: 401 };
}

async function verifyWebhookSignature(signatureHeader, rawBody, secret) {
  const pieces = signatureHeader
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = [];
  let timestamp = "";

  for (const piece of pieces) {
    const [key, ...rest] = piece.split("=");
    const value = rest.join("=").trim();
    if (!value) continue;
    if (["t", "timestamp"].includes(key)) timestamp = value;
    if (["v0", "v1", "signature", "sig"].includes(key)) candidates.push(value.replace(/^sha256=/i, ""));
  }
  if (!candidates.length && signatureHeader) {
    candidates.push(signatureHeader.replace(/^sha256=/i, "").trim());
  }

  const payloads = timestamp ? [`${timestamp}.${rawBody}`, `${timestamp}${rawBody}`, rawBody] : [rawBody];
  for (const payload of payloads) {
    const hex = await hmacSha256Hex(secret, payload);
    const base64 = await hmacSha256Base64(secret, payload);
    for (const candidate of candidates) {
      if (safeEqual(candidate, hex) || safeEqual(candidate, base64)) return true;
    }
  }
  return false;
}

async function hmacSha256Hex(secret, payload) {
  const bytes = await hmacSha256(secret, payload);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Base64(secret, payload) {
  const bytes = await hmacSha256(secret, payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha256(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(signature);
}

function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function withToolAuth(request, env, handler) {
  const auth = validateBearerOrQuery(request, env.BARTLEBY_TOOL_TOKEN, "tool_auth_not_configured");
  if (auth) return auth;
  return handler();
}

async function withAdminAuth(request, env, handler) {
  const auth = validateBearerOrQuery(request, env.ADMIN_TOKEN, "admin_auth_not_configured");
  if (auth) return auth;
  return handler();
}

function validateBearerOrQuery(request, token, notConfiguredStatus) {
  if (!token) {
    return json({ ok: false, status: notConfiguredStatus }, 503);
  }
  const url = new URL(request.url);
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer === token || url.searchParams.get("token") === token) return null;
  return json({ ok: false, status: "unauthorized" }, 401);
}

function isValidTwilioRequest(request, env) {
  if (!env.TWILIO_WEBHOOK_TOKEN) return true;
  const url = new URL(request.url);
  return url.searchParams.get("token") === env.TWILIO_WEBHOOK_TOKEN;
}

async function requestBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return requestJson(request);
  if (contentType.includes("form")) {
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  }
  const text = await request.text();
  if (!text) return {};
  if (text.trim().startsWith("{")) return parseMaybeJson(text) || {};
  return Object.fromEntries(new URLSearchParams(text).entries());
}

async function requestJson(request) {
  const text = await request.text();
  if (!text) return {};
  return parseMaybeJson(text) || {};
}

function parseAllowedCallerNumbers(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizePhone(item))
    .filter(Boolean);
}

function isAllowedCaller(phoneNumber, allowedCallerNumbers) {
  const allowed = parseAllowedCallerNumbers(allowedCallerNumbers);
  if (!allowed.length) return true;
  const normalized = normalizePhone(phoneNumber);
  return allowed.includes(normalized);
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("+")) return `+${text.replace(/\D/g, "")}`;
  const digits = text.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : digits ? `+${digits}` : "";
}

function extractTwiml(text, contentType) {
  const parsed = parseMaybeJson(text);
  if (parsed?.twiml) return String(parsed.twiml);
  if (parsed?.twilio?.twiml) return String(parsed.twilio.twiml);
  if (contentType.includes("xml") || text.trim().startsWith("<")) return text;
  return sayTwiml("Bartleby could not read the ElevenLabs TwiML response.");
}

function attachStreamStatusCallback(twiml, statusCallbackUrl) {
  if (!statusCallbackUrl || !twiml.includes("<Stream") || /<Stream\b[^>]*statusCallback=/i.test(twiml)) {
    return twiml;
  }
  return twiml.replace(
    /<Stream\b/i,
    `<Stream statusCallback="${escapeXml(statusCallbackUrl)}" statusCallbackMethod="POST"`
  );
}

function callbackUrl(request, env, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  if (env.TWILIO_WEBHOOK_TOKEN) url.searchParams.set("token", env.TWILIO_WEBHOOK_TOKEN);
  return url.toString();
}

function sayTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say></Response>`;
}

function testCallerTwiml(env) {
  const prompt =
    env.TWILIO_TEST_CALL_PROMPT ||
    "Hello Bartleby. What are the latest articles in The Economist? Please summarize the top three.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(prompt)}</Say><Pause length="18"/><Say>Thank you Bartleby. Goodbye.</Say></Response>`;
}

function xml(body, status = 200) {
  return new Response(body, { status, headers: XML_HEADERS });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function ensureD1(env) {
  if (!env.DB) throw new Error("D1 binding DB is not configured.");
}

function isTerminalCallStatus(status) {
  return ["completed", "canceled", "busy", "failed", "no-answer"].includes(String(status || "").toLowerCase());
}

function toolName(value) {
  return value?.tool_name || value?.name || value?.tool || value?.function?.name || "";
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nullableText(value) {
  const text = normalize(value);
  return text || null;
}

function normalizeDate(value) {
  const text = normalize(value);
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function unixToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number * 1000).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hash(value) {
  let output = 5381;
  for (const char of String(value || "")) {
    output = ((output << 5) + output + char.charCodeAt(0)) >>> 0;
  }
  return output;
}
