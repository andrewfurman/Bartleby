import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { economistArticle, economistSearch, economistSections, parseFeed } from "../src/rss.mjs";

const sampleFeed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Economist</title>
    <item>
      <title>America tests a new policy</title>
      <link>https://www.economist.com/united-states/2026/06/24/example</link>
      <pubDate>Wed, 24 Jun 2026 12:00:00 GMT</pubDate>
      <category>The United States</category>
      <category>Politics</category>
      <description><![CDATA[An article excerpt about policy.]]></description>
      <content:encoded><![CDATA[<p>Full text about America and policy.</p><p>More context from The Economist.</p>]]></content:encoded>
    </item>
    <item>
      <title>Markets in brief</title>
      <link>https://www.economist.com/business/2026/06/24/markets</link>
      <pubDate>Wed, 24 Jun 2026 10:00:00 GMT</pubDate>
      <category>Business and Finance</category>
      <description>Market excerpt.</description>
    </item>
  </channel>
</rss>`;

describe("Economist RSS parsing", () => {
  it("preserves RSS category tags as sections", () => {
    const parsed = parseFeed(sampleFeed, {
      id: "economist",
      title: "The Economist",
      url: "https://example.com/feed.xml?token=secret",
      private: true,
    });

    assert.equal(parsed.items.length, 2);
    assert.deepEqual(parsed.items[0].categories, ["The United States", "Politics"]);
    assert.equal(parsed.items[0].section, "The United States");
    assert.equal(parsed.feed.feed_url, "https://example.com/feed.xml?token=redacted");
  });

  it("filters by section and query", async () => {
    const env = feedEnv(sampleFeed);
    const result = await economistSearch(env, {
      section: "United States",
      query: "policy",
      limit: 5,
      refresh: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.returned_count, 1);
    assert.equal(result.items[0].title, "America tests a new policy");
  });

  it("lists sections by category counts", async () => {
    const env = feedEnv(sampleFeed);
    const result = await economistSections(env, { refresh: true });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.sections.map((section) => section.section).sort(),
      ["Business and Finance", "Politics", "The United States"].sort()
    );
  });

  it("returns article text by entry id", async () => {
    const env = feedEnv(sampleFeed);
    const search = await economistSearch(env, { query: "America", refresh: true });
    const article = await economistArticle(env, {
      entry_id: search.items[0].id,
      refresh: false,
    });

    assert.equal(article.ok, true);
    assert.match(article.full_text, /Full text about America/);
  });
});

function feedEnv(xml) {
  return {
    ECONOMIST_RSS_URL: "https://example.com/feed.xml?token=secret",
    ECONOMIST_RSS_CACHE_SECONDS: "900",
    ECONOMIST_RSS_TIMEOUT_MS: "12000",
    fetch: undefined,
  };
}

globalThis.fetch = async () =>
  new Response(sampleFeed, {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  });
