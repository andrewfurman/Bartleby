import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/worker.mjs";

describe("Worker tools", () => {
  it("falls back to DuckDuckGo HTML results for outside web search", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.startsWith("https://api.duckduckgo.com/")) {
        return new Response(
          JSON.stringify({
            AbstractText: "",
            RelatedTopics: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (value.startsWith("https://html.duckduckgo.com/html/")) {
        return new Response(
          `<!doctype html>
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fstory&amp;rut=abc">A useful &amp; current result</a>
          <a class="result__snippet">Fresh outside context from the open web.</a>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }

      throw new Error(`Unexpected fetch: ${value}`);
    };

    try {
      const response = await worker.fetch(
        new Request("https://bartleby.example/tools/web-search", {
          method: "POST",
          headers: {
            authorization: "Bearer test-tool-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "outside web context", max_results: 3 }),
        }),
        { BARTLEBY_TOOL_TOKEN: "test-tool-token" },
        {}
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.provider, "duckduckgo_html");
      assert.equal(body.results.length, 1);
      assert.equal(body.results[0].title, "A useful & current result");
      assert.equal(body.results[0].url, "https://example.com/story");
      assert.equal(body.results[0].snippet, "Fresh outside context from the open web.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to Bing HTML results when DuckDuckGo has no useful results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.startsWith("https://api.duckduckgo.com/")) {
        return new Response(JSON.stringify({ AbstractText: "", RelatedTopics: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (value.startsWith("https://html.duckduckgo.com/html/")) {
        return new Response("<!doctype html><p>No results here.</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }

      if (value.startsWith("https://www.bing.com/search")) {
        return new Response(
          `<!doctype html>
          <li class="b_algo"><h2><a href="https://www.gov.uk/government/people/keir-starmer">The Rt Hon Sir Keir Starmer KCB KC MP - GOV.UK</a></h2><p>Official biography page.</p></li>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }

      throw new Error(`Unexpected fetch: ${value}`);
    };

    try {
      const response = await worker.fetch(
        new Request("https://bartleby.example/tools/web-search", {
          method: "POST",
          headers: {
            authorization: "Bearer test-tool-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "outside web context", max_results: 3 }),
        }),
        { BARTLEBY_TOOL_TOKEN: "test-tool-token" },
        {}
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.provider, "bing_html");
      assert.equal(body.results.length, 1);
      assert.equal(body.results[0].title, "The Rt Hon Sir Keir Starmer KCB KC MP - GOV.UK");
      assert.equal(body.results[0].url, "https://www.gov.uk/government/people/keir-starmer");
      assert.equal(body.results[0].snippet, "Official biography page.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not hang up when the caller intent is ambiguous", async () => {
    const originalFetch = globalThis.fetch;
    let twilioCalled = false;
    globalThis.fetch = async () => {
      twilioCalled = true;
      throw new Error("Twilio should not be called for ambiguous hang-up text.");
    };

    try {
      const response = await worker.fetch(
        new Request("https://bartleby.example/tools/call/hang-up", {
          method: "POST",
          headers: {
            authorization: "Bearer test-tool-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ twilio_call_sid: "CA123", user_request: "thanks" }),
        }),
        { BARTLEBY_TOOL_TOKEN: "test-tool-token" },
        {}
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.status, "needs_confirmation");
      assert.equal(twilioCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hangs up through Twilio when the caller clearly says goodbye", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const response = await worker.fetch(
        new Request("https://bartleby.example/tools/call/hang-up", {
          method: "POST",
          headers: {
            authorization: "Bearer test-tool-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            twilio_call_sid: "CA123",
            user_request: "Thanks, that's all, goodbye.",
          }),
        }),
        {
          BARTLEBY_TOOL_TOKEN: "test-tool-token",
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_API_KEY_SID: "SK123",
          TWILIO_API_KEY_SECRET: "secret",
        },
        {}
      );
      const body = await response.json();
      const form = new URLSearchParams(calls[0].options.body);

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.status, "completed");
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/Accounts\/AC123\/Calls\/CA123\.json$/);
      assert.equal(calls[0].options.method, "POST");
      assert.equal(form.get("Status"), "completed");
      assert.match(calls[0].options.headers.authorization, /^Basic /);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
