import { z } from "zod";

export type BriefSource = { kind: "personal_record" | "search" | "subscription" | "weather" | "external_brief"; label: string; url?: string; provider?: string; retrievedAt?: string };
export type BriefSection = { title: string; body: string };

const configSchema = z.object({
  TAVILY_SEARCH_API_KEY: z.string().trim().optional(),
  BRAVE_SEARCH_API_KEY: z.string().trim().optional(),
  BRIEF_EXTERNAL_SOURCES_ENABLED: z.string().trim().optional(),
  BRIEF_SUBSCRIPTIONS_ENABLED: z.string().trim().optional(),
  BRIEF_SUBSCRIPTION_FEEDS_JSON: z.string().trim().optional(),
  BRIEF_SUBSCRIPTION_MAX_AGE_HOURS: z.string().trim().optional()
});
type ProviderConfig = z.infer<typeof configSchema>;
export type SearchResult = { title: string; description: string; url?: string; kind?: BriefSource["kind"]; provider?: string; retrievedAt?: string; publishedAt?: string };
export type SearchStatus = "ok" | "empty" | "unavailable";
export type SearchResponse = { results: SearchResult[]; source: BriefSource | null; status: SearchStatus; provider: string };
type GdeltArticle = { title?: string; url?: string; seendate?: string; domain?: string };
export type BriefSubscriptionSection = "finance" | "ai" | "technology" | "humanities";
type SubscriptionFeed = { label: string; url: string };
type SubscriptionFeedMap = Record<BriefSubscriptionSection, SubscriptionFeed[]>;
type ParsedFeedEntry = SearchResult & { publishedAtMs: number | null };
export type BriefLocation = { name: string; latitude: number; longitude: number; timeZone: string };
export type BriefWeather = { temperatureCelsius: number; apparentTemperatureCelsius: number; weatherCode: number; observedAt: string | null };
export type WeatherResult = { section: BriefSection; source: BriefSource | null; location: BriefLocation | null; weather: BriefWeather | null };
export type BriefDailyForecast = { localDate: string; minimumCelsius: number; maximumCelsius: number; precipitationProbabilityPercent: number | null; weatherCode: number };
export type WeeklyWeatherResult = { source: BriefSource | null; location: BriefLocation | null; days: BriefDailyForecast[] };

const subscriptionFeedSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.string().url().refine((value) => value.startsWith("https://"), "Subscription feeds must use HTTPS.")
}).strict();

const subscriptionFeedMapSchema = z.object({
  finance: z.array(subscriptionFeedSchema).max(8).optional(),
  ai: z.array(subscriptionFeedSchema).max(8).optional(),
  technology: z.array(subscriptionFeedSchema).max(8).optional(),
  humanities: z.array(subscriptionFeedSchema).max(8).optional()
}).strict();

const defaultSubscriptionFeeds: SubscriptionFeedMap = {
  finance: [{ label: "Federal Reserve press releases", url: "https://www.federalreserve.gov/feeds/press_all.xml" }],
  ai: [{ label: "arXiv Artificial Intelligence", url: "https://rss.arxiv.org/rss/cs.AI" }],
  technology: [{ label: "arXiv Computers and Society", url: "https://rss.arxiv.org/rss/cs.CY" }],
  humanities: [{ label: "Smithsonian History", url: "https://www.smithsonianmag.com/rss/history/" }]
};

export class BriefProviders {
  private readonly config: ProviderConfig;
  private readonly externalSourcesEnabled: boolean;
  private readonly subscriptionFeeds: SubscriptionFeedMap;
  private readonly subscriptionMaxAgeMs: number;
  private gdeltQueue: Promise<void> = Promise.resolve();
  private lastGdeltRequestAt = 0;
  private readonly cache = new Map<string, { expiresAt: number; value: SearchResponse }>();
  private readonly subscriptionCache = new Map<BriefSubscriptionSection, { expiresAt: number; value: SearchResponse }>();
  constructor(config = configSchema.parse(process.env), private readonly fetcher: typeof fetch = fetch) {
    this.config = configSchema.parse(config);
    this.externalSourcesEnabled = !isDisabledFlag(this.config.BRIEF_EXTERNAL_SOURCES_ENABLED);
    this.subscriptionFeeds = loadSubscriptionFeeds(this.config);
    this.subscriptionMaxAgeMs = positiveHours(this.config.BRIEF_SUBSCRIPTION_MAX_AGE_HOURS, 96) * 60 * 60 * 1000;
  }

  async subscribe(section: BriefSubscriptionSection): Promise<SearchResponse> {
    if (!this.externalSourcesEnabled) return disabledSearch();
    const cached = this.subscriptionCache.get(section);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const feeds = this.subscriptionFeeds[section];
    if (feeds.length === 0) return { results: [], source: null, status: "empty", provider: "none" };
    const retrievedAt = new Date().toISOString();
    const responses = await Promise.all(feeds.map((feed) => this.readFeed(feed, retrievedAt)));
    const available = responses.filter((response): response is { feed: SubscriptionFeed; entries: ParsedFeedEntry[] } => response !== null);
    if (available.length === 0) return unavailableSearch("rss_subscription");
    const now = Date.now();
    const results = dedupeResults(available.flatMap((response) => response.entries)
      .filter((entry) => entry.publishedAtMs === null || (entry.publishedAtMs <= now + 6 * 60 * 60 * 1000 && now - entry.publishedAtMs <= this.subscriptionMaxAgeMs))
      .sort((left, right) => (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0)))
      .slice(0, 3)
      .map(({ publishedAtMs: _publishedAtMs, ...entry }) => entry);
    const labels = available.map((response) => response.feed.label);
    const value = availableSearch(results, {
      kind: "subscription",
      label: `免费订阅：${labels.join("、")}`,
      provider: "rss_subscription",
      retrievedAt
    }, "rss_subscription");
    this.subscriptionCache.set(section, { expiresAt: Date.now() + 60 * 60 * 1000, value });
    return value;
  }

  async search(query: string): Promise<SearchResponse> {
    if (!this.externalSourcesEnabled) return disabledSearch();
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.config.TAVILY_SEARCH_API_KEY
      ? await this.searchTavily(query, this.config.TAVILY_SEARCH_API_KEY)
      : this.config.BRAVE_SEARCH_API_KEY
        ? await this.searchBrave(query, this.config.BRAVE_SEARCH_API_KEY)
        : await this.searchGdelt(query);
    // A transient provider/network failure must not poison every retry for an hour.
    if (value.status !== "unavailable") this.cache.set(query, { expiresAt: Date.now() + 60 * 60 * 1000, value });
    return value;
  }

  private async searchBrave(query: string, apiKey: string): Promise<SearchResponse> {
    try {
      const response = await this.fetcher(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return unavailableSearch("brave_search");
      const data = await response.json() as { web?: { results?: SearchResult[] } };
      const results = (data.web?.results ?? []).map(({ title, description, url }) => ({ title, description, url })).filter((item) => item.title && item.url);
      return availableSearch(results, { kind: "search", label: `Brave Search：${query}`, provider: "brave_search", retrievedAt: new Date().toISOString() }, "brave_search");
    } catch { return unavailableSearch("brave_search"); }
  }

  private async searchTavily(query: string, apiKey: string): Promise<SearchResponse> {
    try {
      const response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 3, include_answer: false, include_raw_content: false }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return unavailableSearch("tavily_search");
      const data = await response.json() as { results?: Array<{ title?: string; content?: string; url?: string }> };
      const results = (data.results ?? []).flatMap((item) => item.title && item.url ? [{ title: item.title, description: item.content ?? "", url: item.url }] : []);
      return availableSearch(results, { kind: "search", label: `Tavily Search：${query}`, provider: "tavily_search", retrievedAt: new Date().toISOString() }, "tavily_search");
    } catch { return unavailableSearch("tavily_search"); }
  }

  private async searchGdelt(query: string): Promise<SearchResponse> {
    let release!: () => void;
    const previous = this.gdeltQueue;
    this.gdeltQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = Math.max(0, 5_100 - (Date.now() - this.lastGdeltRequestAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await this.fetcher(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=3&sort=hybridrel`, { signal: AbortSignal.timeout(12_000) });
      this.lastGdeltRequestAt = Date.now();
      if (!response.ok) return unavailableSearch("gdelt");
      const data = await response.json() as { articles?: GdeltArticle[] };
      const results = (data.articles ?? []).flatMap((article) => article.title && article.url ? [{ title: article.title, description: `${article.domain ?? "新闻来源"}${article.seendate ? ` · ${article.seendate}` : ""}`, url: article.url }] : []);
      return availableSearch(results, { kind: "search", label: `GDELT 新闻索引：${query}`, provider: "gdelt", retrievedAt: new Date().toISOString() }, "gdelt");
    } catch { return unavailableSearch("gdelt"); }
    finally { release(); }
  }

  private async readFeed(feed: SubscriptionFeed, retrievedAt: string): Promise<{ feed: SubscriptionFeed; entries: ParsedFeedEntry[] } | null> {
    try {
      const response = await this.fetcher(feed.url, {
        headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) return null;
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > 3_000_000) return null;
      const xml = await response.text();
      if (xml.length > 3_000_000) return null;
      return { feed, entries: parseSubscriptionFeed(xml, feed, retrievedAt) };
    } catch {
      return null;
    }
  }

  async weather(locationName?: string): Promise<WeatherResult> {
    const query = locationName?.trim();
    if (!query) return { section: { title: "天气与地点", body: "今日未记录地点。" }, source: null, location: null, weather: null };
    try {
      const geocodingResponse = await this.fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`, { signal: AbortSignal.timeout(8_000) });
      if (!geocodingResponse.ok) throw new Error("geocoding_response_failed");
      const geocoding = await geocodingResponse.json() as { results?: Array<{ name?: string; admin1?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }> };
      const match = geocoding.results?.[0];
      if (!match?.name || match.latitude === undefined || match.longitude === undefined || !match.timezone) {
        return { section: { title: "天气与地点", body: `没有找到“${query}”，请检查地点名称。` }, source: null, location: null, weather: null };
      }
      const name = formatLocationName([match.country, match.admin1, match.name]);
      const location = { name, latitude: match.latitude, longitude: match.longitude, timeZone: match.timezone };
      const response = await this.fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${match.latitude}&longitude=${match.longitude}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_response_failed");
      const data = await response.json() as { timezone?: string; current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; weather_code?: number } };
      const current = data.current;
      if (!current || current.temperature_2m === undefined) throw new Error("weather_payload_missing");
      const observedTimeZone = data.timezone ?? match.timezone;
      const weather = {
        temperatureCelsius: current.temperature_2m,
        apparentTemperatureCelsius: current.apparent_temperature ?? current.temperature_2m,
        weatherCode: current.weather_code ?? -1,
        observedAt: current.time ? withOffset(current.time, observedTimeZone) : null
      };
      return {
        section: { title: "天气与地点", body: `${name}：${weather.temperatureCelsius}°C，体感 ${weather.apparentTemperatureCelsius}°C。` },
        source: { kind: "weather", label: `Open-Meteo：${name}`, url: `https://open-meteo.com/en/docs#latitude=${match.latitude}&longitude=${match.longitude}`, provider: "open_meteo", retrievedAt: new Date().toISOString() },
        location,
        weather
      };
    } catch { return { section: { title: "天气与地点", body: `“${query}”的地点或天气暂时无法获取。` }, source: null, location: null, weather: null }; }
  }

  async weatherAtCoordinates(latitude: number, longitude: number): Promise<WeatherResult> {
    try {
      const reverseResponse = await this.fetcher(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&localityLanguage=zh`, { signal: AbortSignal.timeout(8_000) });
      const reverse = reverseResponse.ok ? await reverseResponse.json() as { countryName?: string; principalSubdivision?: string; city?: string; locality?: string } : {};
      const timezone = "Asia/Shanghai";
      const name = formatLocationName([reverse.countryName, reverse.principalSubdivision, reverse.city, reverse.locality]) || "本机位置（行政区暂不可用）";
      const response = await this.fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_response_failed");
      const data = await response.json() as { timezone?: string; current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; weather_code?: number } };
      const current = data.current;
      if (!current || current.temperature_2m === undefined) throw new Error("weather_payload_missing");
      const observedTimeZone = data.timezone ?? timezone;
      const weather = { temperatureCelsius: current.temperature_2m, apparentTemperatureCelsius: current.apparent_temperature ?? current.temperature_2m, weatherCode: current.weather_code ?? -1, observedAt: current.time ? withOffset(current.time, observedTimeZone) : null };
      return {
        section: { title: "天气与地点", body: `${name}：${weather.temperatureCelsius}°C，体感 ${weather.apparentTemperatureCelsius}°C。` },
        source: { kind: "weather", label: `Open-Meteo：${name}`, url: `https://open-meteo.com/en/docs#latitude=${latitude}&longitude=${longitude}`, provider: "open_meteo", retrievedAt: new Date().toISOString() },
        location: { name, latitude, longitude, timeZone: observedTimeZone },
        weather
      };
    } catch {
      return { section: { title: "天气与地点", body: "本机位置或天气暂时无法获取，请手动填写地点。" }, source: null, location: null, weather: null };
    }
  }

  async weeklyWeather(locationName: string | undefined, startDate: string, endDate: string): Promise<WeeklyWeatherResult> {
    const query = locationName?.trim();
    if (!query) return { source: null, location: null, days: [] };
    try {
      const geocodingResponse = await this.fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`, { signal: AbortSignal.timeout(8_000) });
      if (!geocodingResponse.ok) throw new Error("geocoding_response_failed");
      const geocoding = await geocodingResponse.json() as { results?: Array<{ name?: string; admin1?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }> };
      const match = geocoding.results?.[0];
      if (!match?.name || match.latitude === undefined || match.longitude === undefined || !match.timezone) return { source: null, location: null, days: [] };
      const name = formatLocationName([match.country, match.admin1, match.name]);
      const location = { name, latitude: match.latitude, longitude: match.longitude, timeZone: match.timezone };
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${match.latitude}&longitude=${match.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_forecast_response_failed");
      const data = await response.json() as { daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: Array<number | null> } };
      const daily = data.daily;
      const days = (daily?.time ?? []).flatMap((localDate, index) => {
        const minimumCelsius = daily?.temperature_2m_min?.[index];
        const maximumCelsius = daily?.temperature_2m_max?.[index];
        if (minimumCelsius === undefined || maximumCelsius === undefined) return [];
        return [{
          localDate,
          minimumCelsius,
          maximumCelsius,
          precipitationProbabilityPercent: daily?.precipitation_probability_max?.[index] ?? null,
          weatherCode: daily?.weather_code?.[index] ?? -1
        }];
      });
      return { source: { kind: "weather", label: `Open-Meteo 七日预报：${name}`, provider: "open_meteo", retrievedAt: new Date().toISOString() }, location, days };
    } catch {
      return { source: null, location: null, days: [] };
    }
  }
}

function withOffset(localDateTime: string, timeZone: string): string | null {
  try {
    const date = new Date(`${localDateTime}Z`);
    if (Number.isNaN(date.getTime())) return null;
    const offsetName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
    const offset = offsetName?.match(/GMT([+-]\d{2}:\d{2})/)?.[1];
    return offset ? `${localDateTime}${offset}` : `${localDateTime}Z`;
  } catch { return null; }
}

function formatLocationName(parts: Array<string | undefined | null>): string {
  const normalized = parts
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim().replace(/中华人民共和国/gu, "中国").replace(/中国大陆/gu, "中国"));
  return normalized.filter((part, index) => normalized.indexOf(part) === index).join("，");
}

export function searchSection(title: string, result: SearchResponse): { section: BriefSection; sources: BriefSource[] } {
  if (result.status === "unavailable") return { section: { title, body: "免费订阅和联网搜索暂时不可用；本板块没有写入未经来源支持的内容。" }, sources: [] };
  if (result.results.length === 0) return { section: { title, body: "当前没有可用的可靠订阅或搜索结果。" }, sources: [] };
  const body = result.results.map((item) => `${item.title}：${item.description}`).join("\n\n").slice(0, 4000).trim();
  return { section: { title, body }, sources: result.results.map((item) => ({
    kind: item.kind ?? result.source?.kind ?? "search",
    label: item.title,
    url: item.url,
    provider: item.provider ?? result.source?.provider,
    retrievedAt: item.retrievedAt ?? result.source?.retrievedAt
  })) };
}

export function mergeSearchResponses(primary: SearchResponse, fallback: SearchResponse, limit = 3): SearchResponse {
  const primaryResults = primary.results.map((item) => ({
    ...item,
    kind: item.kind ?? primary.source?.kind ?? "search",
    provider: item.provider ?? primary.source?.provider,
    retrievedAt: item.retrievedAt ?? primary.source?.retrievedAt
  }));
  const fallbackResults = fallback.results.map((item) => ({
    ...item,
    kind: item.kind ?? fallback.source?.kind ?? "search",
    provider: item.provider ?? fallback.source?.provider,
    retrievedAt: item.retrievedAt ?? fallback.source?.retrievedAt
  }));
  const results = dedupeResults([...primaryResults, ...fallbackResults]).slice(0, limit);
  const provider = [primary.provider, fallback.provider].filter((value) => value !== "none").join("+") || "none";
  const status: SearchStatus = results.length > 0
    ? "ok"
    : primary.status === "unavailable" && fallback.status === "unavailable"
      ? "unavailable"
      : "empty";
  return {
    results,
    source: results.length ? {
      kind: primary.results.length ? "subscription" : fallback.source?.kind ?? "search",
      label: `来源组合：${provider}`,
      provider,
      retrievedAt: new Date().toISOString()
    } : null,
    status,
    provider
  };
}

function availableSearch(results: SearchResult[], source: BriefSource, provider: string): SearchResponse {
  return { results, source, status: results.length ? "ok" : "empty", provider };
}

function unavailableSearch(provider: string): SearchResponse {
  return { results: [], source: null, status: "unavailable", provider };
}

function disabledSearch(): SearchResponse {
  return { results: [], source: null, status: "empty", provider: "disabled" };
}

function isDisabledFlag(value: string | undefined): boolean {
  return /^(?:0|false|off|no)$/iu.test(value ?? "");
}

function loadSubscriptionFeeds(config: ProviderConfig): SubscriptionFeedMap {
  if (/^(?:0|false|off|no)$/iu.test(config.BRIEF_SUBSCRIPTIONS_ENABLED ?? "")) return emptySubscriptionFeeds();
  if (!config.BRIEF_SUBSCRIPTION_FEEDS_JSON) return structuredClone(defaultSubscriptionFeeds);
  let parsed: unknown;
  try {
    parsed = JSON.parse(config.BRIEF_SUBSCRIPTION_FEEDS_JSON);
  } catch {
    throw new Error("BRIEF_SUBSCRIPTION_FEEDS_JSON must be valid JSON.");
  }
  const custom = subscriptionFeedMapSchema.parse(parsed);
  return {
    finance: custom.finance ?? [],
    ai: custom.ai ?? [],
    technology: custom.technology ?? [],
    humanities: custom.humanities ?? []
  };
}

function emptySubscriptionFeeds(): SubscriptionFeedMap {
  return { finance: [], ai: [], technology: [], humanities: [] };
}

function positiveHours(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24 * 14) throw new Error("BRIEF_SUBSCRIPTION_MAX_AGE_HOURS must be between 1 and 336.");
  return parsed;
}

function parseSubscriptionFeed(xml: string, feed: SubscriptionFeed, retrievedAt: string): ParsedFeedEntry[] {
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/giu) ?? [];
  return blocks.flatMap((block) => {
    const title = xmlText(firstTag(block, ["title"]));
    const url = validHttpUrl(firstTag(block, ["link"]) || linkHref(block));
    if (!title || !url) return [];
    const description = xmlText(firstTag(block, ["description", "summary", "content", "content:encoded"])) || feed.label;
    const dateText = xmlText(firstTag(block, ["pubDate", "published", "updated", "dc:date"]));
    const publishedAtMs = dateText ? Date.parse(dateText) : Number.NaN;
    const publishedAt = Number.isFinite(publishedAtMs) ? new Date(publishedAtMs).toISOString() : undefined;
    return [{
      title: title.slice(0, 240),
      description: description.slice(0, 700),
      url,
      kind: "subscription" as const,
      provider: "rss_subscription",
      retrievedAt,
      publishedAt,
      publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : null
    }];
  });
}

function firstTag(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name.replace(":", "\\:")}\\b[^>]*>([\\s\\S]*?)<\\/${name.replace(":", "\\:")}>`, "iu"));
    if (match?.[1]) return match[1];
  }
  return "";
}

function linkHref(block: string): string {
  return block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/iu)?.[1] ?? "";
}

function xmlText(value: string): string {
  return decodeXml(value.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/gu, "").replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

function validHttpUrl(value: string): string | null {
  const normalized = decodeXml(value.trim());
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function dedupeResults<T extends SearchResult>(results: T[]): T[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url?.trim().toLowerCase() || `${result.title.trim().toLowerCase()}\u0000${result.description.trim().toLowerCase()}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
