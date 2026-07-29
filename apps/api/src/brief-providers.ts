import { z } from "zod";

export type BriefSource = { kind: "personal_record" | "search" | "weather"; label: string; url?: string; provider?: string; retrievedAt?: string };
export type BriefSection = { title: string; body: string };

const configSchema = z.object({
  BRAVE_SEARCH_API_KEY: z.string().trim().optional(),
  BRIEF_LOCATION_NAME: z.string().trim().optional(),
  BRIEF_LOCATION_LAT: z.coerce.number().min(-90).max(90).optional(),
  BRIEF_LOCATION_LON: z.coerce.number().min(-180).max(180).optional()
});
type ProviderConfig = z.infer<typeof configSchema>;
type SearchResult = { title: string; description: string; url: string };
type GdeltArticle = { title?: string; url?: string; seendate?: string; domain?: string };

export class BriefProviders {
  private readonly config: ProviderConfig;
  private gdeltQueue: Promise<void> = Promise.resolve();
  private lastGdeltRequestAt = 0;
  private readonly cache = new Map<string, { expiresAt: number; value: { results: SearchResult[]; source: BriefSource | null } }>();
  constructor(config = configSchema.parse(process.env)) { this.config = config; }

  async search(query: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.config.BRAVE_SEARCH_API_KEY ? await this.searchBrave(query, this.config.BRAVE_SEARCH_API_KEY) : await this.searchGdelt(query);
    this.cache.set(query, { expiresAt: Date.now() + 60 * 60 * 1000, value });
    return value;
  }

  private async searchBrave(query: string, apiKey: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { results: [], source: null };
    const data = await response.json() as { web?: { results?: SearchResult[] } };
    const results = (data.web?.results ?? []).map(({ title, description, url }) => ({ title, description, url })).filter((item) => item.title && item.url);
    return { results, source: { kind: "search", label: `Brave Search：${query}`, provider: "brave_search", retrievedAt: new Date().toISOString() } };
  }

  private async searchGdelt(query: string): Promise<{ results: SearchResult[]; source: BriefSource | null }> {
    let release!: () => void;
    const previous = this.gdeltQueue;
    this.gdeltQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = Math.max(0, 5_100 - (Date.now() - this.lastGdeltRequestAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=3&sort=hybridrel`, { signal: AbortSignal.timeout(12_000) });
      this.lastGdeltRequestAt = Date.now();
      if (!response.ok) return { results: [], source: null };
      const data = await response.json() as { articles?: GdeltArticle[] };
      const results = (data.articles ?? []).flatMap((article) => article.title && article.url ? [{ title: article.title, description: `${article.domain ?? "新闻来源"}${article.seendate ? ` · ${article.seendate}` : ""}`, url: article.url }] : []);
      return { results, source: { kind: "search", label: `GDELT 新闻索引：${query}`, provider: "gdelt", retrievedAt: new Date().toISOString() } };
    } catch { return { results: [], source: null }; }
    finally { release(); }
  }

  async weather(): Promise<{ section: BriefSection; source: BriefSource | null }> {
    const { BRIEF_LOCATION_NAME: name, BRIEF_LOCATION_LAT: lat, BRIEF_LOCATION_LON: lon } = this.config;
    if (!name || lat === undefined || lon === undefined) return { section: { title: "天气与地点", body: "未配置地点；不会猜测你的所在位置。" }, source: null };
    try {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("weather_response_failed");
      const data = await response.json() as { current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number } };
      const current = data.current;
      if (!current || current.temperature_2m === undefined) throw new Error("weather_payload_missing");
      return { section: { title: "天气与地点", body: `${name}：${current.temperature_2m}°C，体感 ${current.apparent_temperature ?? current.temperature_2m}°C，天气代码 ${current.weather_code ?? "未知"}。` }, source: { kind: "weather", label: `Open-Meteo：${name}`, url: `https://open-meteo.com/en/docs#latitude=${lat}&longitude=${lon}`, provider: "open_meteo", retrievedAt: new Date().toISOString() } };
    } catch { return { section: { title: "天气与地点", body: `${name} 的天气暂时无法获取。` }, source: null }; }
  }
}

export function searchSection(title: string, result: { results: SearchResult[]; source: BriefSource | null }): { section: BriefSection; sources: BriefSource[] } {
  if (result.results.length === 0) return { section: { title, body: result.source ? "当前没有可用的可靠搜索结果。" : "未配置搜索服务，因此没有生成外部资讯。" }, sources: [] };
  return { section: { title, body: result.results.map((item) => `${item.title}：${item.description}`).join("\n\n") }, sources: result.results.map((item) => ({ kind: "search", label: item.title, url: item.url, provider: "brave_search", retrievedAt: result.source?.retrievedAt })) };
}
