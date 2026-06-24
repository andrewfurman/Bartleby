const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const apiKeySid = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_API_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_API_SECRET;
const publicBaseUrl = stripTrailingSlash(process.env.BARTLEBY_PUBLIC_BASE_URL || "");
const webhookToken = process.env.TWILIO_WEBHOOK_TOKEN || "";
const preferredAreaCode = process.env.TWILIO_AREA_CODE || "";
const preferredPostalCode = process.env.TWILIO_POSTAL_CODE || "";
const requireSms = process.env.TWILIO_REQUIRE_SMS === "true";
const existingNumber = process.env.BARTLEBY_TWILIO_PHONE_NUMBER || "";
const confirmPurchase =
  process.env.TWILIO_PURCHASE_CONFIRM === "true" || process.argv.includes("--yes");

if (!accountSid) fail("Missing TWILIO_ACCOUNT_SID.");
if (!authToken && !(apiKeySid && apiKeySecret)) {
  fail("Missing TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID plus TWILIO_API_KEY_SECRET.");
}
if (!publicBaseUrl) fail("Missing BARTLEBY_PUBLIC_BASE_URL.");

const voiceUrl = `${publicBaseUrl}/twilio/inbound${webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ""}`;
const statusUrl = `${publicBaseUrl}/twilio/status${webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ""}`;

if (existingNumber) {
  const updated = await updateIncomingNumber(existingNumber);
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "updated_existing_number",
        phone_number: updated.phone_number,
        sid: updated.sid,
        voice_url: redactUrl(updated.voice_url),
        status_callback: redactUrl(updated.status_callback),
      },
      null,
      2
    )
  );
  process.exit(0);
}

const available = await findAvailableNumbers();
if (!available.length) fail("No US local voice-enabled Twilio numbers were available for this query.");

const selected = available[0];
if (!confirmPurchase) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        status: "purchase_confirmation_required",
        selected_phone_number: selected.phone_number,
        locality: selected.locality || "",
        region: selected.region || "",
        voice_url: voiceUrl,
        message:
          "Set TWILIO_PURCHASE_CONFIRM=true or rerun with --yes to buy this recurring-cost Twilio number.",
      },
      null,
      2
    )
  );
  process.exit(2);
}

const purchased = await purchaseNumber(selected.phone_number);
console.log(
  JSON.stringify(
    {
      ok: true,
      action: "purchased_number",
      phone_number: purchased.phone_number,
      sid: purchased.sid,
      voice_url: redactUrl(purchased.voice_url),
      status_callback: redactUrl(purchased.status_callback),
    },
    null,
    2
  )
);

async function findAvailableNumbers() {
  const url = twilioUrl(`/AvailablePhoneNumbers/US/Local.json`);
  url.searchParams.set("VoiceEnabled", "true");
  if (requireSms) url.searchParams.set("SmsEnabled", "true");
  url.searchParams.set("PageSize", "20");
  if (preferredAreaCode) url.searchParams.set("AreaCode", preferredAreaCode);
  if (preferredPostalCode) url.searchParams.set("InPostalCode", preferredPostalCode);
  url.searchParams.set("ExcludeAllAddressRequired", "true");
  const body = await twilioRequest(url.toString());
  return body.available_phone_numbers || [];
}

async function purchaseNumber(phoneNumber) {
  return twilioRequest(twilioUrl("/IncomingPhoneNumbers.json").toString(), {
    method: "POST",
    body: twilioForm({
      PhoneNumber: phoneNumber,
      FriendlyName: "Bartleby",
      VoiceUrl: voiceUrl,
      VoiceMethod: "POST",
      StatusCallback: statusUrl,
      StatusCallbackMethod: "POST",
    }),
  });
}

async function updateIncomingNumber(phoneNumber) {
  const listUrl = twilioUrl("/IncomingPhoneNumbers.json");
  listUrl.searchParams.set("PhoneNumber", phoneNumber);
  const list = await twilioRequest(listUrl.toString());
  const number = list.incoming_phone_numbers?.[0];
  if (!number?.sid) fail(`Could not find existing Twilio number ${phoneNumber}.`);

  return twilioRequest(twilioUrl(`/IncomingPhoneNumbers/${number.sid}.json`).toString(), {
    method: "POST",
    body: twilioForm({
      FriendlyName: "Bartleby",
      VoiceUrl: voiceUrl,
      VoiceMethod: "POST",
      StatusCallback: statusUrl,
      StatusCallbackMethod: "POST",
    }),
  });
}

async function twilioRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKeySid || accountSid}:${apiKeySecret || authToken}`).toString("base64")}`,
      ...(options.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: options.body,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Twilio request failed (${response.status}): ${text.slice(0, 1000)}`);
  }
  return body;
}

function twilioUrl(pathname) {
  return new URL(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${pathname}`);
}

function twilioForm(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params;
}

function redactUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.searchParams.has("token")) url.searchParams.set("token", "redacted");
    return url.toString();
  } catch {
    return String(value).replace(/token=[^&\s]+/g, "token=redacted");
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
