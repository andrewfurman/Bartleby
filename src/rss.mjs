const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;
const DEFAULT_CACHE_SECONDS = 900;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_EXCERPT_CHARS = 420;
const DEFAULT_MAX_TEXT_CHARS = 60_000;
const DEFAULT_BOOTSTRAP_LIMIT = 200;
const DEFAULT_BOOTSTRAP_MAX_CHARS = 60_000;

let feedCache = null;

export async function economistSections(env, { refresh = false } = {}) {
  const result = await loadEconomistFeed(env, { refresh });
  if (!result.ok) return result;

  const counts = new Map();
  for (const item of result.items) {
    for (const category of item.categories) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }

  const sections = [...counts.entries()]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count || a.section.localeCompare(b.section));

  return {
    ok: true,
    status: "ok",
    provider: "economist_rss",
    returned_count: sections.length,
    sections,
    feed: result.feed,
    answer_text: sections.length
      ? `I found ${sections.length} Economist sections in the RSS feed.`
      : "I did not find section categories in the Economist RSS feed.",
  };
}

export async function economistRecent(env, options = {}) {
  return economistSearch(env, {
    ...options,
    query: "",
  });
}

export async function economistSearch(
  env,
  {
    query = "",
    section = "",
    category = "",
    categories = [],
    start_date: startDate = "",
    end_date: endDate = "",
    limit = DEFAULT_LIMIT,
    refresh = false,
  } = {}
) {
  const normalizedQuery = normalize(query).toLowerCase();
  const requestedSections = sectionFilters({ section, category, categories });
  const result = await loadEconomistFeed(env, { refresh, categories: requestedSections });
  if (!result.ok) return result;

  const after = dateSeconds(startDate);
  const before = dateSeconds(endDate);
  const boundedLimit = clampInteger(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);

  const filteredItems = result.items.filter((item) => {
    if (requestedSections.length) {
      const inSection = requestedSections.some((requestedSection) => itemMatchesSection(item, requestedSection));
      if (!inSection) return false;
    }

    const published = dateSeconds(item.published_at || item.updated_at);
    if (after && published && published < after) return false;
    if (before && published && published > before) return false;

    if (normalizedQuery) {
      const haystack = [
        item.title,
        item.author,
        item.summary,
        item.full_text,
        item.categories.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }

    return true;
  });

  const items = filteredItems
    .sort(compareByPublishedDesc)
    .slice(0, boundedLimit)
    .map((item) => compactEntry(item));

  return {
    ok: true,
    status: "ok",
    provider: "economist_rss",
    source: result.feed.id,
    query: normalize(query),
    section: requestedSections.join(", "),
    categories: requestedSections,
    start_date: normalize(startDate),
    end_date: normalize(endDate),
    returned_count: items.length,
    total_count: filteredItems.length,
    feed: result.feed,
    items,
    answer_text: entriesAnswerText(items, { query, section: requestedSections.join(", ") }),
  };
}

export async function economistBootstrap(env, options = {}) {
  const result = await loadEconomistFeed(env, { refresh: options.refresh === true });
  if (!result.ok) return result;

  const limit = clampInteger(
    options.limit || env.BARTLEBY_BOOTSTRAP_ARTICLE_LIMIT,
    1,
    MAX_LIMIT,
    DEFAULT_BOOTSTRAP_LIMIT
  );
  const maxChars = clampInteger(
    options.max_chars || env.BARTLEBY_BOOTSTRAP_MAX_CHARS,
    10_000,
    200_000,
    DEFAULT_BOOTSTRAP_MAX_CHARS
  );
  const recentArticles = [...result.items]
    .sort(compareByPublishedDesc)
    .slice(0, limit)
    .map((item) => bootstrapEntry(item));
  const usInBrief = latestBriefEntry(result.items, "us");
  const worldInBrief = latestBriefEntry(result.items, "world");
  const contextText = truncate(bootstrapContextText(result, recentArticles, usInBrief, worldInBrief), maxChars);

  return {
    ok: true,
    status: "ok",
    provider: "economist_rss",
    feed: result.feed,
    fetched_at: result.fetched_at,
    source_item_count: result.item_count,
    recent_article_count: recentArticles.length,
    us_in_brief: usInBrief ? bootstrapEntry(usInBrief, { excerptChars: 900 }) : null,
    world_in_brief: worldInBrief ? bootstrapEntry(worldInBrief, { excerptChars: 900 }) : null,
    recent_articles: recentArticles,
    context_text: contextText.value,
    context_truncated: contextText.truncated,
    answer_text: `Loaded ${recentArticles.length} recent Economist RSS articles for call startup context.`,
  };
}

export async function economistArticle(
  env,
  { entry_id: entryId = "", id = "", url = "", article_url: articleUrl = "", max_text_chars: maxTextChars, refresh = false } = {}
) {
  const result = await loadEconomistFeed(env, { refresh });
  if (!result.ok) return result;

  const requestedId = normalize(entryId || id);
  const requestedUrl = canonicalUrl(url || articleUrl);
  if (!requestedId && !requestedUrl) {
    return {
      ok: false,
      status: "missing_entry_id",
      provider: "economist_rss",
      answer_text: "I need an Economist RSS entry id or article URL to retrieve the article.",
    };
  }

  const item = result.items.find((entry) => {
    if (requestedId && entry.id === requestedId) return true;
    if (requestedUrl && canonicalUrl(entry.url) === requestedUrl) return true;
    return false;
  });

  if (!item) {
    return {
      ok: false,
      status: "rss_entry_not_found",
      provider: "economist_rss",
      entry_id: requestedId,
      article_url: requestedUrl,
      answer_text: "I could not find that Economist article in the current RSS feed.",
    };
  }

  const boundedMax = clampInteger(maxTextChars, 2_000, 120_000, DEFAULT_MAX_TEXT_CHARS);
  const text = normalizeArticleText(item.full_text || item.summary || "");
  const truncated = truncate(text, boundedMax);
  const fullArticleAvailable = text.length >= 700 && item.content_source !== "feed_summary";

  return {
    ok: true,
    status: "ok",
    provider: "economist_rss",
    source: result.feed.id,
    entry: compactEntry(item, { excerptChars: 700 }),
    entry_id: item.id,
    full_article_available: fullArticleAvailable,
    content_source: item.content_source,
    full_text_chars: text.length,
    returned_text_chars: truncated.value.length,
    full_text_truncated: truncated.truncated,
    access_note:
      fullArticleAvailable || text.length >= 700
        ? ""
        : "The RSS feed appears to provide only an excerpt for this article.",
    full_text: truncated.value,
    answer_text: fullArticleAvailable
      ? `Retrieved "${item.title}" from The Economist RSS feed.`
      : `Retrieved "${item.title}", but the RSS feed may only include an excerpt.`,
  };
}

export async function loadEconomistFeed(env, { refresh = false, categories = [] } = {}) {
  const config = economistFeedConfig(env, { categories });
  if (!config.url) {
    return {
      ok: false,
      status: "rss_feed_not_configured",
      provider: "economist_rss",
      answer_text: "The Economist RSS feed URL is not configured yet.",
    };
  }

  const now = Date.now();
  if (
    !refresh &&
    feedCache?.ok &&
    feedCache.cache_key === config.cacheKey &&
    now - feedCache.fetched_at_ms < config.cacheSeconds * 1000
  ) {
    return { ...feedCache, cache_status: "hit" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      signal: controller.signal,
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": "bartleby-economist-rss/0.1",
        ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
      },
    });
    const xml = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: "rss_feed_request_failed",
        provider: "economist_rss",
        upstream_status: response.status,
        message: xml.slice(0, 500),
        answer_text: "I could not fetch the Economist RSS feed.",
      };
    }

    const parsed = parseFeed(xml, {
      id: config.id,
      title: config.title,
      url: config.url,
      private: config.private,
      cache_seconds: config.cacheSeconds,
    });
    const result = {
      ok: true,
      status: "ok",
      provider: "economist_rss",
      cache_status: "refreshed",
      cache_key: config.cacheKey,
      fetched_at_ms: now,
      fetched_at: new Date(now).toISOString(),
      item_count: parsed.items.length,
      feed: parsed.feed,
      items: parsed.items,
    };
    feedCache = result;
    return result;
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? "rss_feed_timeout" : "rss_feed_request_failed",
      provider: "economist_rss",
      message: error?.message || String(error),
      answer_text: "I could not fetch the Economist RSS feed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseFeed(xml, feedConfig = {}) {
  const text = String(xml || "");
  const feedTitle = tagText(text, "title") || feedConfig.title || "The Economist";
  const feed = {
    id: feedConfig.id || "economist",
    title: feedTitle,
    private: Boolean(feedConfig.private),
    cache_seconds: feedConfig.cache_seconds || DEFAULT_CACHE_SECONDS,
    feed_url: redactedUrl(feedConfig.url, Boolean(feedConfig.private)),
  };

  const rssItems = xmlBlocks(text, "item");
  if (rssItems.length) {
    return {
      feed,
      items: rssItems.map((block) => rssItem(block, feed)),
    };
  }

  const atomEntries = xmlBlocks(text, "entry");
  return {
    feed,
    items: atomEntries.map((block) => atomItem(block, feed)),
  };
}

function rssItem(block, feed) {
  const title = tagText(block, "title");
  const url = normalize(tagText(block, "link") || tagText(block, "guid"));
  const explicitCategories = tagTexts(block, "category").filter(Boolean);
  const categories = itemCategories(explicitCategories, { title, url });
  const contentHtml = tagText(block, "content:encoded") || tagText(block, "encoded");
  const summaryHtml = tagText(block, "description") || tagText(block, "summary");
  const fullText = normalizeArticleText(htmlToText(contentHtml || summaryHtml));
  const summary = normalizeArticleText(htmlToText(summaryHtml || contentHtml));
  const publishedAt = normalizeDate(
    tagText(block, "pubDate") || tagText(block, "published") || tagText(block, "dc:date")
  );
  const updatedAt = normalizeDate(tagText(block, "updated"));

  return {
    id: entryId(feed.id, url || tagText(block, "guid") || title),
    feed_id: feed.id,
    feed_title: feed.title,
    title,
    url,
    author: tagText(block, "author") || tagText(block, "dc:creator"),
    categories,
    section: categories[0] || "",
    published_at: publishedAt,
    updated_at: updatedAt,
    content_source: contentHtml ? "feed_content_encoded" : "feed_summary",
    full_text: fullText,
    summary,
    full_text_available: contentHtml ? fullText.length >= 700 : false,
    reading_time: readingTime(fullText),
  };
}

function atomItem(block, feed) {
  const title = tagText(block, "title");
  const url = atomLink(block) || tagText(block, "id");
  const explicitCategories = atomCategories(block);
  const categories = itemCategories(explicitCategories, { title, url });
  const contentHtml = tagText(block, "content");
  const summaryHtml = tagText(block, "summary");
  const fullText = normalizeArticleText(htmlToText(contentHtml || summaryHtml));
  const summary = normalizeArticleText(htmlToText(summaryHtml || contentHtml));
  const publishedAt = normalizeDate(tagText(block, "published"));
  const updatedAt = normalizeDate(tagText(block, "updated"));

  return {
    id: entryId(feed.id, url || tagText(block, "id") || title),
    feed_id: feed.id,
    feed_title: feed.title,
    title,
    url,
    author: nestedTagText(block, "author", "name"),
    categories,
    section: categories[0] || "",
    published_at: publishedAt || updatedAt,
    updated_at: updatedAt,
    content_source: contentHtml ? "feed_content" : "feed_summary",
    full_text: fullText,
    summary,
    full_text_available: contentHtml ? fullText.length >= 700 : false,
    reading_time: readingTime(fullText),
  };
}

function economistFeedConfig(env, options = {}) {
  const json = normalize(env.ECONOMIST_RSS_CONFIG_JSON);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const feed = Array.isArray(parsed?.feeds) ? parsed.feeds[0] : Array.isArray(parsed) ? parsed[0] : parsed;
      if (feed?.url) {
        return normalizeFeedConfig(feed, env, options);
      }
    } catch {
      // Fall through to the simple env var config.
    }
  }

  return normalizeFeedConfig(
    {
      id: env.ECONOMIST_RSS_ID || "economist",
      title: env.ECONOMIST_RSS_TITLE || "The Economist",
      url: env.ECONOMIST_RSS_URL || "",
      private: true,
      cache_seconds: env.ECONOMIST_RSS_CACHE_SECONDS,
      timeout_ms: env.ECONOMIST_RSS_TIMEOUT_MS,
      bearer_token: env.ECONOMIST_RSS_BEARER_TOKEN || env.ECONOMIST_RSS_AUTH_TOKEN,
    },
    env,
    options
  );
}

function normalizeFeedConfig(feed, env, { categories = [] } = {}) {
  const baseUrl = normalize(feed.url || feed.feed_url || feed.feedUrl);
  const categoryFilters = sectionFilters({ categories });
  const url = categoryFilters.length ? categoryFilterUrl(baseUrl, categoryFilters) : baseUrl;
  const cacheSeconds = clampInteger(
    feed.cache_seconds || feed.cacheSeconds || env.ECONOMIST_RSS_CACHE_SECONDS,
    0,
    86_400,
    DEFAULT_CACHE_SECONDS
  );
  const timeoutMs = clampInteger(
    feed.timeout_ms || feed.timeoutMs || env.ECONOMIST_RSS_TIMEOUT_MS,
    2_000,
    60_000,
    DEFAULT_TIMEOUT_MS
  );
  const bearerToken = normalize(
    feed.bearer_token ||
      feed.bearerToken ||
      feed.auth_token ||
      feed.authToken ||
      (feed.auth_token_env ? env[feed.auth_token_env] : "") ||
      (feed.authTokenEnv ? env[feed.authTokenEnv] : "") ||
      env.ECONOMIST_RSS_BEARER_TOKEN ||
      env.ECONOMIST_RSS_AUTH_TOKEN
  );

  return {
    id: normalizeFeedId(feed.id || "economist"),
    title: normalize(feed.title || "The Economist"),
    url,
    private: toBoolean(feed.private, true),
    cacheSeconds,
    timeoutMs,
    bearerToken,
    categoryFilters,
    cacheKey: `${url}|${cacheSeconds}|${Boolean(bearerToken)}|${categoryFilters.join(",")}`,
  };
}

function compactEntry(item, { excerptChars = DEFAULT_EXCERPT_CHARS } = {}) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    author: item.author,
    published_at: item.published_at,
    updated_at: item.updated_at,
    feed_id: item.feed_id,
    feed_title: item.feed_title,
    section: item.section,
    categories: item.categories,
    content_source: item.content_source,
    full_text_available: item.full_text_available,
    reading_time: item.reading_time,
    excerpt: truncate(item.summary || item.full_text || "", excerptChars).value,
  };
}

function bootstrapEntry(item, { excerptChars = 220 } = {}) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    published_at: item.published_at,
    section: item.section,
    categories: item.categories,
    content_source: item.content_source,
    full_text_available: item.full_text_available,
    reading_time: item.reading_time,
    excerpt: truncate(item.summary || item.full_text || "", excerptChars).value,
  };
}

function latestBriefEntry(items, kind) {
  const matcher = kind === "world" ? isWorldInBrief : isUsInBrief;
  return [...items].sort(compareByPublishedDesc).find(matcher) || null;
}

function isUsInBrief(item) {
  return (
    item.categories.includes("The US in Brief") ||
    item.categories.includes("The U.S. in Brief") ||
    /^(the )?(us|u\.s\.|united states) in brief\b/i.test(item.title)
  );
}

function isWorldInBrief(item) {
  return (
    item.categories.includes("The World in Brief") ||
    /^(the )?world in brief\b/i.test(item.title) ||
    /\/the-world-in-brief\//i.test(item.url)
  );
}

function bootstrapContextText(result, recentArticles, usInBrief, worldInBrief) {
  const lines = [
    "Bartleby startup context from The Economist RSS feed.",
    `Feed: ${result.feed.title || result.feed.id}. Fetched at: ${result.fetched_at}. Source entries parsed: ${result.item_count}.`,
    "",
    "Use this context before calling tools. For broad latest-article questions, scan the recent article index below before saying an article or section is missing.",
    "",
    "Latest U.S. in Brief:",
    usInBrief ? articleContextLine(bootstrapEntry(usInBrief, { excerptChars: 700 })) : "Not found in the configured RSS feed.",
    "",
    "Latest World in Brief:",
    worldInBrief
      ? articleContextLine(bootstrapEntry(worldInBrief, { excerptChars: 700 }))
      : "Not found in the configured RSS feed. If asked, say the current RSS feed did not include a World in Brief entry in the preloaded recent article index.",
    "",
    `Most recent ${recentArticles.length} Economist RSS articles:`,
    ...recentArticles.map((item, index) => `${index + 1}. ${articleContextLine(item)}`),
  ];
  return lines.join("\n");
}

function articleContextLine(item) {
  const published = item.published_at ? item.published_at.slice(0, 10) : "undated";
  const section = item.section || "Unsectioned";
  const fullText =
    item.full_text_available === true
      ? " Full text: available in RSS."
      : item.full_text_available === false
        ? " Full text: excerpt/summary only in RSS."
        : "";
  const readingTime = item.reading_time ? ` Reading time: ${item.reading_time} min.` : "";
  const excerpt = item.excerpt ? ` Excerpt: ${item.excerpt}` : "";
  return `[${published}] ${item.title} (${section}) ${item.url}.${fullText}${readingTime}${excerpt}`;
}

function entriesAnswerText(items, { query, section }) {
  const scope = section ? ` in ${section}` : "";
  if (!items.length) {
    return query
      ? `I did not find Economist RSS articles matching "${normalize(query)}"${scope}.`
      : `I did not find recent Economist RSS articles${scope}.`;
  }

  const leading = query
    ? `Found ${items.length} Economist RSS article${items.length === 1 ? "" : "s"} matching "${normalize(query)}"${scope}.`
    : `Returned ${items.length} recent Economist RSS article${items.length === 1 ? "" : "s"}${scope}.`;
  const titles = items
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.title}${item.section ? ` (${item.section})` : ""}`)
    .join(" ");
  return `${leading} ${titles}`;
}

function xmlBlocks(xml, tagName) {
  const escaped = escapeRegExp(tagName);
  return [...String(xml || "").matchAll(new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}>`, "gi"))].map(
    (match) => match[0]
  );
}

function tagText(block, tagName) {
  const values = tagTexts(block, tagName);
  return values[0] || "";
}

function tagTexts(block, tagName) {
  const escaped = escapeRegExp(tagName);
  return [...String(block || "").matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "gi"))]
    .map((match) => decodeXml(stripCdata(match[1])).trim())
    .filter(Boolean);
}

function nestedTagText(block, outerTagName, innerTagName) {
  const outer = xmlBlocks(block, outerTagName)[0];
  return outer ? tagText(outer, innerTagName) : "";
}

function atomLink(block) {
  const alternate = String(block || "").match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  if (alternate) return decodeXml(alternate[1]);
  const first = String(block || "").match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return first ? decodeXml(first[1]) : "";
}

function atomCategories(block) {
  const categories = [];
  for (const match of String(block || "").matchAll(/<category\b[^>]*>/gi)) {
    const tag = match[0];
    const term = tag.match(/\bterm=["']([^"']+)["']/i)?.[1];
    const label = tag.match(/\blabel=["']([^"']+)["']/i)?.[1];
    const value = decodeXml(label || term || "").trim();
    if (value) categories.push(value);
  }
  return categories;
}

function itemCategories(explicitCategories, { title, url }) {
  const briefSections = inferredBriefSections(title);
  if (!explicitCategories.length) return inferredEconomistCategories({ title, url });
  return uniqueStrings([...briefSections, ...explicitCategories]);
}

function inferredEconomistCategories({ title, url }) {
  const categories = inferredBriefSections(title);

  const pathSection = inferredPathSection(url);
  if (pathSection && !categories.includes(pathSection)) categories.push(pathSection);

  return categories;
}

function inferredBriefSections(title) {
  const normalizedTitle = normalize(title).toLowerCase();
  if (/^(the )?(us|u\.s\.|united states) in brief\b/.test(normalizedTitle)) {
    return ["The US in Brief", "In Brief", "United States"];
  }
  if (/^(the )?world in brief\b/.test(normalizedTitle)) return ["The World in Brief"];
  return [];
}

function inferredPathSection(value) {
  let firstSegment = "";
  try {
    firstSegment = new URL(value).pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    firstSegment = String(value || "").split("/").filter(Boolean)[0] || "";
  }

  const sections = {
    "the-world-in-brief": "The World in Brief",
    "in-brief": "In Brief",
    leaders: "Leaders",
    "by-invitation": "By Invitation",
    "united-states": "United States",
    britain: "Britain",
    europe: "Europe",
    americas: "The Americas",
    asia: "Asia",
    china: "China",
    "middle-east-and-africa": "Middle East and Africa",
    business: "Business",
    "finance-and-economics": "Finance and Economics",
    "science-and-technology": "Science and Technology",
    culture: "Culture",
    obituary: "Obituary",
    "graphic-detail": "Graphic Detail",
    "the-economist-explains": "The Economist Explains",
    "special-report": "Special Report",
    "technology-quarterly": "Technology Quarterly",
    "schools-brief": "Schools Brief",
    podcasts: "Podcasts",
    interactive: "Interactive",
    "international": "International",
    "1843": "1843",
  };

  return sections[firstSegment.toLowerCase()] || titleCaseSlug(firstSegment);
}

function titleCaseSlug(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function htmlToText(html) {
  return decodeXml(
    stripCdata(String(html || ""))
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripCdata(value) {
  const text = String(value || "").trim();
  const match = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1] : text;
}

function normalizeArticleText(value) {
  return normalize(value)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeDate(value) {
  const text = normalize(value);
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function dateSeconds(value) {
  const text = normalize(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

function compareByPublishedDesc(a, b) {
  return (dateSeconds(b.published_at || b.updated_at) || 0) - (dateSeconds(a.published_at || a.updated_at) || 0);
}

function readingTime(text) {
  const words = normalize(text).split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.ceil(words / 225)) : 0;
}

function entryId(feedId, value) {
  return `${feedId}:${hashString(canonicalUrl(value) || normalize(value).toLowerCase()).toString(36)}`;
}

function hashString(value) {
  let hash = 5381;
  for (const char of String(value || "")) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function canonicalUrl(value) {
  const text = normalize(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    return url.toString();
  } catch {
    return text;
  }
}

function sectionFilters({ section = "", category = "", categories = [] } = {}) {
  const rawValues = [
    section,
    category,
    ...(Array.isArray(categories) ? categories : [categories]),
  ];
  const filters = [];
  for (const value of rawValues) {
    for (const part of String(value || "").split(",")) {
      const expanded = expandSectionAlias(part);
      for (const item of expanded) {
        if (item && !filters.includes(item)) filters.push(item);
      }
    }
  }
  return filters;
}

function expandSectionAlias(value) {
  const text = normalize(value);
  if (!text) return [];
  const key = text
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bu\.s\.\b/g, "us")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const aliases = {
    us: ["United States"],
    "u s": ["United States"],
    usa: ["United States"],
    america: ["United States"],
    "the united states": ["United States"],
    "united states": ["United States"],
    "us in brief": ["The US in Brief"],
    "u s in brief": ["The US in Brief"],
    "the us in brief": ["The US in Brief"],
    "the u s in brief": ["The US in Brief"],
    "united states in brief": ["The US in Brief"],
    "the united states in brief": ["The US in Brief"],
    "world in brief": ["The World in Brief"],
    "the world in brief": ["The World in Brief"],
    "business and finance": ["Business", "Finance and Economics"],
    business: ["Business"],
    finance: ["Finance and Economics"],
    "finance economics": ["Finance and Economics"],
    "finance and economics": ["Finance and Economics"],
    "middle east africa": ["Middle East and Africa"],
    "middle east and africa": ["Middle East and Africa"],
    "science technology": ["Science and Technology"],
    "science and technology": ["Science and Technology"],
    tech: ["Science and Technology"],
    technology: ["Science and Technology"],
    leaders: ["Leaders"],
    leader: ["Leaders"],
    "leader section": ["Leaders"],
    obituaries: ["Obituary"],
    obituary: ["Obituary"],
  };
  return aliases[key] || [text];
}

function itemMatchesSection(item, requestedSection) {
  const requested = sectionComparable(requestedSection);
  const labels = new Set([item.section, ...item.categories]);
  if (isUsInBrief(item)) labels.add("The US in Brief");
  if (isWorldInBrief(item)) labels.add("The World in Brief");
  if (requested === "us in brief" || requested === "united states in brief") return isUsInBrief(item);
  if (requested === "united states") {
    return !isUsInBrief(item) && [...labels].some((label) => sectionComparable(label) === "united states");
  }
  for (const label of labels) {
    const comparable = sectionComparable(label);
    if (!comparable) continue;
    if (comparable === requested || comparable.includes(requested) || requested.includes(comparable)) return true;
  }
  return false;
}

function sectionComparable(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bu\.s\.\b/g, "us")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function categoryFilterUrl(value, categories) {
  try {
    const url = new URL(value);
    url.searchParams.delete("category");
    url.searchParams.delete("categories");
    for (const category of rssCategoryFilters(categories)) url.searchParams.append("category", category);
    return url.toString();
  } catch {
    return value;
  }
}

function rssCategoryFilters(categories) {
  const filters = [];
  for (const category of categories) {
    const comparable = sectionComparable(category);
    const rssCategory = comparable === "us in brief" || comparable === "united states in brief" ? "In Brief" : category;
    if (!filters.includes(rssCategory)) filters.push(rssCategory);
  }
  return filters;
}

function redactedUrl(value, isPrivate) {
  const text = normalize(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (isPrivate || /token|secret|key|auth|session|password|signature/i.test(key)) {
        url.searchParams.set(key, "redacted");
      }
    }
    return url.toString();
  } catch {
    return isPrivate ? "[private]" : text;
  }
}

function normalizeFeedId(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function truncate(value, maxChars) {
  const text = normalizeArticleText(value);
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: `${text.slice(0, Math.max(0, maxChars - 1)).trim()}...`, truncated: true };
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values) {
  const unique = [];
  for (const value of values) {
    if (value && !unique.includes(value)) unique.push(value);
  }
  return unique;
}
