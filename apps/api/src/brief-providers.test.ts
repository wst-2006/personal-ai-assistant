import { describe, expect, it, vi } from "vitest";
import { BriefProviders } from "./brief-providers.js";

describe("brief weather provider", () => {
  it("does not request or guess a location when the user leaves it empty", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const providers = new BriefProviders({}, fetcher);

    const result = await providers.weather();

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.location).toBeNull();
    expect(result.weather).toBeNull();
    expect(result.section.body).toContain("未记录地点");
  });

  it("resolves a user-entered city and returns a structured weather snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ name: "杭州", admin1: "浙江", country: "中国", latitude: 30.25, longitude: 120.17, timezone: "Asia/Shanghai" }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        current: { time: "2026-07-29T15:00", temperature_2m: 32.1, apparent_temperature: 36.4, weather_code: 3 }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const providers = new BriefProviders({}, fetcher);

    const result = await providers.weather("杭州");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("geocoding-api.open-meteo.com");
    expect(result.location).toEqual({ name: "杭州，浙江，中国", latitude: 30.25, longitude: 120.17, timeZone: "Asia/Shanghai" });
    expect(result.weather).toMatchObject({ temperatureCelsius: 32.1, apparentTemperatureCelsius: 36.4, weatherCode: 3 });
    expect(result.source?.provider).toBe("open_meteo");
  });

  it("keeps brief generation usable when a city cannot be resolved", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const result = await new BriefProviders({}, fetcher).weather("不存在的地点");

    expect(result.location).toBeNull();
    expect(result.section.body).toContain("没有找到");
  });
});

describe("brief search provider", () => {
  it("uses Tavily when its server-only key is configured", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: "Tavily result", content: "A concise result", url: "https://example.com/tavily" }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await new BriefProviders({ TAVILY_SEARCH_API_KEY: "test-key" }, fetcher).search("人工智能 今日要闻");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.tavily.com/search");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1] && (fetcher.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ api_key: "test-key", query: "人工智能 今日要闻", max_results: 3 });
    expect(result.results[0]).toEqual({ title: "Tavily result", description: "A concise result", url: "https://example.com/tavily" });
    expect(result.source?.provider).toBe("tavily_search");
  });
});
