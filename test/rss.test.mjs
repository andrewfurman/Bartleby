import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { economistArticle, economistBootstrap, economistSearch, economistSections, parseFeed } from "../src/rss.mjs";

const sampleFeed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Economist</title>
    <item>
      <title>America tests a new policy</title>
      <link>https://www.economist.com/united-states/2026/06/24/example</link>
      <pubDate>Wed, 24 Jun 2026 12:00:00 GMT</pubDate>
      <category>United States</category>
      <category>Politics</category>
      <description><![CDATA[An article excerpt about policy.]]></description>
      <content:encoded><![CDATA[<p>Full text about America and policy.</p><p>More context from The Economist.</p>]]></content:encoded>
    </item>
    <item>
      <title>The US in Brief: A big night in New York</title>
      <link>https://www.economist.com/in-brief/2026/06/24/the-us-in-brief-a-big-night-in-new-york</link>
      <pubDate>Wed, 24 Jun 2026 11:21:54 GMT</pubDate>
      <category>In Brief</category>
      <category>United States</category>
      <description><![CDATA[Our daily political update.]]></description>
      <content:encoded><![CDATA[<p>A full daily political update from The Economist.</p><p>More brief context.</p>]]></content:encoded>
    </item>
    <item>
      <title>A new business strategy</title>
      <link>https://www.economist.com/business/2026/06/24/markets</link>
      <pubDate>Wed, 24 Jun 2026 10:00:00 GMT</pubDate>
      <category>Business</category>
      <description>Business excerpt.</description>
    </item>
    <item>
      <title>Markets in brief</title>
      <link>https://www.economist.com/finance-and-economics/2026/06/24/markets</link>
      <pubDate>Wed, 24 Jun 2026 09:00:00 GMT</pubDate>
      <category>Finance and Economics</category>
      <description>Market excerpt.</description>
    </item>
  </channel>
</rss>`;

const publicEconomistStyleFeed = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Latest Updates</title>
    <item>
      <title>
        <![CDATA[The US in Brief: A big night in New York]]>
      </title>
      <description><![CDATA[Our daily political update.]]></description>
      <link>https://www.economist.com/in-brief/2026/06/24/the-us-in-brief-a-big-night-in-new-york</link>
      <guid isPermaLink="false">us-brief</guid>
      <pubDate>Wed, 24 Jun 2026 11:21:54 +0000</pubDate>
    </item>
    <item>
      <title><![CDATA[The World in Brief: Tensions rise]]></title>
      <description><![CDATA[A compact update on world news.]]></description>
      <link>https://www.economist.com/the-world-in-brief/2026/06/24/tensions-rise</link>
      <guid isPermaLink="false">world-brief</guid>
      <pubDate>Wed, 24 Jun 2026 11:00:00 +0000</pubDate>
    </item>
    <item>
      <title><![CDATA[Don’t restrict Chinese biotech]]></title>
      <description><![CDATA[Patients benefit from faster, cheaper treatments.]]></description>
      <link>https://www.economist.com/leaders/2026/06/18/dont-restrict-chinese-biotech</link>
      <guid isPermaLink="false">leaders-biotech</guid>
      <pubDate>Thu, 18 Jun 2026 12:45:58 +0000</pubDate>
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

    assert.equal(parsed.items.length, 4);
    assert.deepEqual(parsed.items[0].categories, ["United States", "Politics"]);
    assert.equal(parsed.items[0].section, "United States");
    assert.deepEqual(parsed.items[1].categories, ["The US in Brief", "In Brief", "United States"]);
    assert.equal(parsed.items[1].section, "The US in Brief");
    assert.equal(parsed.feed.feed_url, "https://example.com/feed.xml?token=redacted");
  });

  it("infers Economist sections when public RSS omits category tags", () => {
    const parsed = parseFeed(publicEconomistStyleFeed, {
      id: "economist",
      title: "The Economist",
      url: "https://www.economist.com/latest/rss.xml",
    });

    assert.equal(parsed.items.length, 3);
    assert.equal(parsed.items[0].title, "The US in Brief: A big night in New York");
    assert.deepEqual(parsed.items[0].categories, ["The US in Brief", "In Brief", "United States"]);
    assert.equal(parsed.items[0].section, "The US in Brief");
    assert.deepEqual(parsed.items[1].categories, ["The World in Brief"]);
    assert.equal(parsed.items[1].section, "The World in Brief");
    assert.deepEqual(parsed.items[2].categories, ["Leaders"]);
    assert.equal(parsed.items[2].section, "Leaders");
  });

  it("builds startup context with briefs and a bounded recent index", async () => {
    const env = feedEnv(publicEconomistStyleFeed);
    const result = await economistBootstrap(env, { limit: 2, refresh: true });

    assert.equal(result.ok, true);
    assert.equal(result.recent_article_count, 2);
    assert.equal(result.us_in_brief.title, "The US in Brief: A big night in New York");
    assert.equal(result.world_in_brief.title, "The World in Brief: Tensions rise");
    assert.match(result.context_text, /Most recent 2 Economist RSS articles/);
    assert.match(result.context_text, /The US in Brief: A big night in New York/);
  });

  it("sends bearer auth when configured for a private RSS feed", async () => {
    const env = {
      ...feedEnv(sampleFeed),
      ECONOMIST_RSS_BEARER_TOKEN: "private-feed-token",
    };
    await economistSections(env, { refresh: true });

    assert.equal(globalThis.__lastFetchOptions.headers.authorization, "Bearer private-feed-token");
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
    assert.match(globalThis.__lastFetchUrl, /[?&]category=United\+States(?:&|$)/);
  });

  it("keeps The US in Brief separate from the United States section", async () => {
    const env = feedEnv(sampleFeed);
    const unitedStates = await economistSearch(env, {
      section: "United States",
      limit: 10,
      refresh: true,
    });
    const usInBrief = await economistSearch(env, {
      section: "US in Brief",
      limit: 10,
      refresh: true,
    });

    const url = new URL(globalThis.__lastFetchUrl);

    assert.equal(unitedStates.ok, true);
    assert.deepEqual(
      unitedStates.items.map((item) => item.title),
      ["America tests a new policy"]
    );
    assert.equal(usInBrief.ok, true);
    assert.deepEqual(
      usInBrief.items.map((item) => item.title),
      ["The US in Brief: A big night in New York"]
    );
    assert.deepEqual(url.searchParams.getAll("category"), ["In Brief"]);
  });

  it("keeps Business separate from Finance and Economics", async () => {
    const env = feedEnv(sampleFeed);
    const business = await economistSearch(env, {
      section: "Business",
      limit: 5,
      refresh: true,
    });
    const businessUrl = new URL(globalThis.__lastFetchUrl);
    const finance = await economistSearch(env, {
      section: "Finance and Economics",
      limit: 5,
      refresh: true,
    });
    const financeUrl = new URL(globalThis.__lastFetchUrl);

    assert.equal(business.ok, true);
    assert.deepEqual(
      business.items.map((item) => item.title),
      ["A new business strategy"]
    );
    assert.deepEqual(businessUrl.searchParams.getAll("category"), ["Business"]);
    assert.equal(finance.ok, true);
    assert.deepEqual(
      finance.items.map((item) => item.title),
      ["Markets in brief"]
    );
    assert.deepEqual(financeUrl.searchParams.getAll("category"), ["Finance and Economics"]);
  });

  it("lists sections by category counts", async () => {
    const env = feedEnv(sampleFeed);
    const result = await economistSections(env, { refresh: true });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.sections.map((section) => section.section).sort(),
      ["Business", "Finance and Economics", "In Brief", "Politics", "The US in Brief", "United States"].sort()
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
  globalThis.__testFeedXml = xml;
  return {
    ECONOMIST_RSS_URL: "https://example.com/feed.xml?token=secret",
    ECONOMIST_RSS_CACHE_SECONDS: "900",
    ECONOMIST_RSS_TIMEOUT_MS: "12000",
    fetch: undefined,
  };
}

globalThis.fetch = async (_url, options = {}) => {
  globalThis.__lastFetchUrl = String(_url);
  globalThis.__lastFetchOptions = options;
  return new Response(globalThis.__testFeedXml || sampleFeed, {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  });
};
