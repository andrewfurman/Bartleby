const publicBaseUrl = stripTrailingSlash(process.env.BARTLEBY_PUBLIC_BASE_URL || "");
const toolToken = process.env.BARTLEBY_TOOL_TOKEN || "";
const adminToken = process.env.ADMIN_TOKEN || "";
const postCallToken = process.env.ELEVENLABS_POST_CALL_TOKEN || "";

if (!publicBaseUrl) fail("Missing BARTLEBY_PUBLIC_BASE_URL.");

const results = [];
results.push(await checkHealth());

if (toolToken) {
  results.push(await checkEconomistSections());
} else {
  results.push({ name: "economist_sections", ok: false, skipped: true, reason: "BARTLEBY_TOOL_TOKEN unset" });
}

if (postCallToken && adminToken) {
  results.push(await checkPostCallLogging());
} else {
  results.push({
    name: "post_call_logging",
    ok: false,
    skipped: true,
    reason: "ELEVENLABS_POST_CALL_TOKEN and ADMIN_TOKEN are required",
  });
}

if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TEST_CALL_FROM_NUMBER && process.env.BARTLEBY_TWILIO_PHONE_NUMBER) {
  results.push(await startTwilioTestCall());
} else {
  results.push({
    name: "twilio_test_call",
    ok: false,
    skipped: true,
    reason:
      "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TEST_CALL_FROM_NUMBER, and BARTLEBY_TWILIO_PHONE_NUMBER to place a phone test call.",
  });
}

const ok = results.every((item) => item.ok || item.skipped);
console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);

async function checkHealth() {
  const response = await fetch(`${publicBaseUrl}/health`);
  const body = await response.json().catch(() => ({}));
  return {
    name: "health",
    ok: response.ok && body.ok === true,
    status: response.status,
    body,
  };
}

async function checkEconomistSections() {
  const response = await fetch(`${publicBaseUrl}/tools/economist/sections`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({}));
  return {
    name: "economist_sections",
    ok: response.ok && body.ok === true,
    status: response.status,
    returned_count: body.returned_count ?? null,
    service_status: body.status,
    answer_text: body.answer_text,
  };
}

async function checkPostCallLogging() {
  const conversationId = `smoke-${Date.now()}`;
  const event = {
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: "test-agent",
      agent_name: "Bartleby",
      conversation_id: conversationId,
      status: "done",
      transcript: [
        {
          role: "agent",
          message: "Hello, this is Bartleby.",
          time_in_call_secs: 0,
          tool_calls: null,
          tool_results: null,
        },
        {
          role: "user",
          message: "What is new in The Economist?",
          time_in_call_secs: 2,
          tool_calls: null,
          tool_results: null,
        },
        {
          role: "agent",
          message: "I will check The Economist RSS feed.",
          time_in_call_secs: 4,
          tool_calls: [{ tool_name: "economist_recent", params_as_json: "{\"limit\":3}" }],
          tool_results: [{ tool_name: "economist_recent", result_value: "{\"ok\":true}" }],
        },
      ],
      metadata: {
        start_time_unix_secs: Math.floor(Date.now() / 1000) - 10,
        call_duration_secs: 10,
      },
      analysis: {
        transcript_summary: "Smoke test conversation for Bartleby logging.",
      },
      conversation_initiation_client_data: {
        dynamic_variables: {
          caller_number: "+15555550100",
          twilio_number: "+15555550101",
          twilio_call_sid: `CAsmoke${Date.now()}`,
        },
      },
    },
  };

  const postResponse = await fetch(`${publicBaseUrl}/elevenlabs/post-call?token=${encodeURIComponent(postCallToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const postBody = await postResponse.json().catch(() => ({}));
  if (!postResponse.ok || postBody.ok !== true) {
    return {
      name: "post_call_logging",
      ok: false,
      status: postResponse.status,
      body: postBody,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const getResponse = await fetch(`${publicBaseUrl}/admin/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const getBody = await getResponse.json().catch(() => ({}));
  return {
    name: "post_call_logging",
    ok:
      getResponse.ok &&
      getBody.ok === true &&
      getBody.transcript_turns?.length === 3 &&
      getBody.tool_events?.length === 2,
    status: getResponse.status,
    conversation_id: conversationId,
    transcript_turns: getBody.transcript_turns?.length || 0,
    tool_events: getBody.tool_events?.length || 0,
  };
}

async function startTwilioTestCall() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TEST_CALL_FROM_NUMBER;
  const to = process.env.BARTLEBY_TWILIO_PHONE_NUMBER;
  const webhookToken = process.env.TWILIO_WEBHOOK_TOKEN || "";
  const scriptUrl = `${publicBaseUrl}/twilio/test-caller-script${webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ""}`;

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Url: scriptUrl,
      Method: "POST",
    }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    name: "twilio_test_call",
    ok: response.ok,
    status: response.status,
    call_sid: body.sid,
    to,
    from,
  };
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
