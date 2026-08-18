import { describe, expect, it, vi } from "vitest";
import { BriefProviders, mergeSearchResponses, searchSection } from "./brief-providers.js";

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

  it("returns a dated seven-day forecast for health candidates without inventing missing days", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ name: "杭州", admin1: "浙江", country: "中国", latitude: 30.25, longitude: 120.17, timezone: "Asia/Shanghai" }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        daily: {
          time: ["2026-08-09", "2026-08-10"],
          weather_code: [3, 61],
          temperature_2m_max: [34, 31],
          temperature_2m_min: [27, 25],
          precipitation_probability_max: [20, 70]
        }
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await new BriefProviders({}, fetcher).weeklyWeather("杭州", "2026-08-09", "2026-08-15");

    expect(String(fetcher.mock.calls[1]?.[0])).toContain("start_date=2026-08-09&end_date=2026-08-15");
    expect(result.location?.name).toBe("杭州，浙江，中国");
    expect(result.days).toEqual([
      { localDate: "2026-08-09", minimumCelsius: 27, maximumCelsius: 34, precipitationProbabilityPercent: 20, weatherCode: 3 },
      { localDate: "2026-08-10", minimumCelsius: 25, maximumCelsius: 31, precipitationProbabilityPercent: 70, weatherCode: 61 }
    ]);
    expect(result.source?.provider).toBe("open_meteo");
  });
});

describe("brief search provider", () => {
  it("makes no subscription or search request when external brief sources are disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const providers = new BriefProviders({ BRIEF_EXTERNAL_SOURCES_ENABLED: "false", TAVILY_SEARCH_API_KEY: "must-not-be-used" }, fetcher);

    const subscription = await providers.subscribe("ai");
    const search = await providers.search("不应联网");

    expect(fetcher).not.toHaveBeenCalled();
    expect(subscription).toEqual({ results: [], source: null, status: "empty", provider: "disabled" });
    expect(search).toEqual({ results: [], source: null, status: "empty", provider: "disabled" });
  });

  it("reads a recent free RSS subscription before paid or indexed search", async () => {
    const publishedAt = new Date().toUTCString();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`<?xml version="1.0"?><rss><channel><item><title>Open AI research update</title><link>https://example.com/ai-update</link><description><![CDATA[<p>A source-backed subscription summary.</p>]]></description><pubDate>${publishedAt}</pubDate></item></channel></rss>`, {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    }));
    const providers = new BriefProviders({
      BRIEF_SUBSCRIPTION_FEEDS_JSON: JSON.stringify({ ai: [{ label: "Test AI feed", url: "https://example.com/feed.xml" }] })
    }, fetcher);

    const result = await providers.subscribe("ai");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", provider: "rss_subscription" });
    expect(result.results[0]).toMatchObject({
      title: "Open AI research update",
      description: "A source-backed subscription summary.",
      url: "https://example.com/ai-update",
      kind: "subscription",
      provider: "rss_subscription"
    });
    expect(searchSection("AI", result).sources[0]).toMatchObject({ kind: "subscription", provider: "rss_subscription" });
  });

  it("fills an insufficient subscription result with search without duplicating URLs", () => {
    const subscription = {
      status: "ok" as const,
      provider: "rss_subscription",
      source: { kind: "subscription" as const, label: "feed", provider: "rss_subscription" },
      results: [{ title: "Subscribed", description: "From RSS", url: "https://example.com/one", kind: "subscription" as const }]
    };
    const search = {
      status: "ok" as const,
      provider: "gdelt",
      source: { kind: "search" as const, label: "search", provider: "gdelt" },
      results: [
        { title: "Duplicate", description: "Same URL", url: "https://example.com/one" },
        { title: "Search fill", description: "From search", url: "https://example.com/two" }
      ]
    };

    const result = mergeSearchResponses(subscription, search);

    expect(result.status).toBe("ok");
    expect(result.results.map((item) => item.url)).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(searchSection("AI", result).sources.map((source) => source.kind)).toEqual(["subscription", "search"]);
  });

  it("keeps generated search sections within the daily brief contract", () => {
    const result = searchSection("AI", {
      source: { kind: "search", label: "test", provider: "test" },
      status: "ok",
      provider: "test",
      results: [{ title: "Long result", description: "x".repeat(10_000), url: "https://example.com" }]
    });
    expect(result.section.body.length).toBeLessThanOrEqual(4000);
  });

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
    expect(result.status).toBe("ok");
  });

  it("does not cache a transient provider failure and labels it honestly", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ title: "Recovered", content: "Source-backed result", url: "https://example.com/recovered" }]
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const providers = new BriefProviders({ TAVILY_SEARCH_API_KEY: "test-key" }, fetcher);

    const failed = await providers.search("恢复测试");
    const recovered = await providers.search("恢复测试");

    expect(failed).toMatchObject({ status: "unavailable", provider: "tavily_search", results: [] });
    expect(searchSection("AI", failed).section.body).toContain("暂时不可用");
    expect(recovered).toMatchObject({ status: "ok", provider: "tavily_search" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
