import { z } from "zod";

export type BriefSource = { kind: "personal_record" | "search" | "weather"; label: string; url?: string; provider?: string; retrievedAt?: string };
export type BriefSection = { title: string; body: string };

const configSchema = z.object({
  TAVILY_SEARCH_API_KEY: z.string().trim().optional(),
  BRAVE_SEARCH_API_KEY: z.string().trim().optional()
});
type ProviderConfig = z.infer<typeof configSchema>;
export type SearchResult = { title: string; description: string; url: string };
type GdeltArticle = { title?: string; url?: string; seendate?: string; domain?: string };
export type BriefLocation = { name: string; latitude: number; longitude: number; timeZone: string };
export type BriefWeather = { temperatureCelsius: number; apparentTemperatureCelsius: number; weatherCode: number; observedAt: string | null };
type WeatherResult = { section: BriefSection; source: BriefSource | null; location: BriefLocation | null; weather: BriefWeather | null };

export class BriefProviders {
  private readonly config: ProviderConfig;
  private gdeltQueue: Promise<void> = Promise.resolve();
  private lastGdeltRequestAt = 0;
  private readonly cache = new Map<string, { expiresAt: number; value: { results: SearchResult[]; source: BriefSource | null } }>();
  constructor(config = configSchema.parse(process.env), private readonly fetcher: typeof fetch = fetch) { this.config = config; }

  async search(query: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.config.TAVILY_SEARCH_API_KEY
      ? await this.searchTavily(query, this.config.TAVILY_SEARCH_API_KEY)
      : this.config.BRAVE_SEARCH_API_KEY
        ? await this.searchBrave(query, this.config.BRAVE_SEARCH_API_KEY)
        : await this.searchGdelt(query);
    this.cache.set(query, { expiresAt: Date.now() + 60 * 60 * 1000, value });
    return value;
  }

  private async searchBrave(query: string, apiKey: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    try {
      const response = await this.fetcher(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return { results: [], source: null };
      const data = await response.json() as { web?: { results?: SearchResult[] } };
      const results = (data.web?.results ?? []).map(({ title, description, url }) => ({ title, description, url })).filter((item) => item.title && item.url);
      return { results, source: { kind: "search", label: `Brave Search：${query}`, provider: "brave_search", retrievedAt: new Date().toISOString() } };
    } catch { return { results: [], source: null }; }
  }

  private async searchTavily(query: string, apiKey: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    try {
      const response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 3, include_answer: false, include_raw_content: false }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return { results: [], source: null };
      const data = await response.json() as { results?: Array<{ title?: string; content?: string; url?: string }> };
      const results = (data.results ?? []).flatMap((item) => item.title && item.url ? [{ title: item.title, description: item.content ?? "", url: item.url }] : []);
      return { results, source: { kind: "search", label: `Tavily Search：${query}`, provider: "tavily_search", retrievedAt: new Date().toISOString() } };
    } catch { return { results: [], source: null }; }
  }

  private async searchGdelt(query: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    let release!: () => void;
    const previous = this.gdeltQueue;
    this.gdeltQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = Math.max(0, 5_100 - (Date.now() - this.lastGdeltRequestAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await this.fetcher(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=3&sort=hybridrel`, { signal: AbortSignal.timeout(12_000) });
      this.lastGdeltRequestAt = Date.now();
      if (!response.ok) return { results: [], source: null };
      const data = await response.json() as { articles?: GdeltArticle[] };
      const results = (data.articles ?? []).flatMap((article) => article.title && article.url ? [{ title: article.title, description: `${article.domain ?? "新闻来源"}${article.seendate ? ` · ${article.seendate}` : ""}`, url: article.url }] : []);
      return { results, source: { kind: "search", label: `GDELT 新闻索引：${query}`, provider: "gdelt", retrievedAt: new Date().toISOString() } };
    } catch { return { results: [], source: null }; }
    finally { release(); }
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
      const name = [match.name, match.admin1, match.country].filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index).join("，");
      const location = { name, latitude: match.latitude, longitude: match.longitude, timeZone: match.timezone };
      const response = await this.fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${match.latitude}&longitude=${match.longitude}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_response_failed");
      const data = await response.json() as { current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; weather_code?: number } };
      const current = data.current;
      if (!current || current.temperature_2m === undefined) throw new Error("weather_payload_missing");
      const weather = {
        temperatureCelsius: current.temperature_2m,
        apparentTemperatureCelsius: current.apparent_temperature ?? current.temperature_2m,
        weatherCode: current.weather_code ?? -1,
        observedAt: current.time ? withOffset(current.time, match.timezone) : null
      };
      return {
        section: { title: "天气与地点", body: `${name}：${weather.temperatureCelsius}°C，体感 ${weather.apparentTemperatureCelsius}°C，天气代码 ${weather.weatherCode === -1 ? "未知" : weather.weatherCode}。` },
        source: { kind: "weather", label: `Open-Meteo：${name}`, url: `https://open-meteo.com/en/docs#latitude=${match.latitude}&longitude=${match.longitude}`, provider: "open_meteo", retrievedAt: new Date().toISOString() },
        location,
        weather
      };
    } catch { return { section: { title: "天气与地点", body: `“${query}”的地点或天气暂时无法获取。` }, source: null, location: null, weather: null }; }
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

export function searchSection(title: string, result: { results: SearchResult[]; source: BriefSource | null }): { section: BriefSection; sources: BriefSource[] } {
  if (result.results.length === 0) return { section: { title, body: result.source ? "当前没有可用的可靠搜索结果。" : "未配置搜索服务，因此没有生成外部资讯。" }, sources: [] };
  const body = result.results.map((item) => `${item.title}：${item.description}`).join("\n\n").slice(0, 4000).trim();
  return { section: { title, body }, sources: result.results.map((item) => ({ kind: "search", label: item.title, url: item.url, provider: result.source?.provider, retrievedAt: result.source?.retrievedAt })) };
}
